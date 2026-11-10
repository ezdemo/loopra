package almarelay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type inaccessibleHost struct{ calls atomic.Int64 }

func (h *inaccessibleHost) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	h.calls.Add(1)
	w.WriteHeader(http.StatusOK)
}

func TestRelayTransportRejectsPlaintextAndCleansUp(t *testing.T) {
	code := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	id, err := routingID(code)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(id))
	checked := make(chan error, 1)
	disconnected := make(chan struct{})
	upgrader := websocket.Upgrader{}
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			checked <- err
			return
		}
		defer conn.Close()
		defer close(disconnected)
		var registration struct {
			Type  string `json:"t"`
			Hash  string `json:"tokenHash"`
			Key   string `json:"key"`
			Proto int    `json:"proto"`
		}
		if err := conn.ReadJSON(&registration); err != nil {
			checked <- err
			return
		}
		if registration.Type != "register" || registration.Hash != hex.EncodeToString(hash[:]) || registration.Key != "test-key" || registration.Proto != 1 {
			checked <- context.Canceled
			return
		}
		if err := conn.WriteJSON(map[string]any{"t": "registered", "proto": 1}); err != nil {
			checked <- err
			return
		}
		if err := conn.WriteJSON(frame{Type: "hreq", ID: "plaintext", Method: "GET", Path: "/api/config"}); err != nil {
			checked <- err
			return
		}
		var response frame
		if err := conn.ReadJSON(&response); err != nil {
			checked <- err
			return
		}
		if response.Type != "hres" || response.Status != 403 {
			checked <- context.Canceled
			return
		}
		if err := conn.ReadJSON(&response); err != nil {
			checked <- err
			return
		}
		if response.Type != "hend" {
			checked <- context.Canceled
			return
		}
		if err := conn.WriteJSON(frame{Type: "wopen", ID: "wrong-socket", Path: "/ws/threads"}); err != nil {
			checked <- err
			return
		}
		if err := conn.ReadJSON(&response); err != nil {
			checked <- err
			return
		}
		if response.Type != "werr" {
			checked <- context.Canceled
			return
		}
		checked <- nil
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer relay.Close()
	service, err := New(Config{URL: relay.URL, Key: "test-key", ConnectCode: code})
	if err != nil {
		t.Fatal(err)
	}
	host := &inaccessibleHost{}
	service.Start(t.Context(), host)
	defer service.Close()
	select {
	case err := <-checked:
		if err != nil {
			t.Fatal("relay boundary check", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay timeout")
	}
	if host.calls.Load() != 0 {
		t.Fatal("plaintext reached application")
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-disconnected:
	case <-time.After(time.Second):
		t.Fatal("relay connection leaked")
	}
	if service.Status().State != "stopped" {
		t.Fatal(service.Status().State)
	}
}

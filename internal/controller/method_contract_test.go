package controller

import (
	"io"
	"net/http"
	"testing"
)

func TestMethodNotAllowedContract(t *testing.T) {
	server, key := newTestServer(t)
	client := server.Client()
	for _, probe := range []struct {
		method string
		path   string
		status int
		allow  string
	}{
		{http.MethodGet, "/api/chat/stream", http.StatusMethodNotAllowed, "POST"},
		{http.MethodGet, "/api/snapshots/checkpoint", http.StatusMethodNotAllowed, "POST, DELETE"},
		{http.MethodPost, "/api/does-not-exist", http.StatusNotFound, ""},
		{http.MethodPut, "/api/git/status", http.StatusMethodNotAllowed, "GET, HEAD, POST"},
		{http.MethodDelete, "/api/config", http.StatusMethodNotAllowed, "GET, HEAD, PUT"},
	} {
		request, err := http.NewRequest(probe.method, server.URL+probe.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Loopra-Key", key)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != probe.status {
			t.Fatalf("%s %s status=%d body=%q", probe.method, probe.path, response.StatusCode, body)
		}
		if allow := response.Header.Get("Allow"); allow != probe.allow {
			t.Fatalf("%s %s allow=%q want %q", probe.method, probe.path, allow, probe.allow)
		}
	}
}

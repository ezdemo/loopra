package controller

import (
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/almarelay"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func remoteTestController(t *testing.T) *Controller {
	t.Helper()
	s, _, err := New(nil, Options{Home: t.TempDir(), AccessKey: "test-key"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestRemoteRelayConfigurationRoutesAndSecretHandling(t *testing.T) {
	s := remoteTestController(t)
	manager, err := almarelay.NewManager(repository.NewAlmaRelayRepository(s.home), almarelay.Config{})
	if err != nil {
		t.Fatal(err)
	}
	s.remoteRelay = manager
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	status, body := call(t, ts, http.MethodPut, "/api/remote/relay", "test-key", map[string]any{"enabled": true, "relayUrl": "https://relay.example", "registrationKey": "fixture-key"})
	if status != 200 {
		t.Fatal(body)
	}
	data := body["data"].(map[string]any)
	link := data["pairingLink"]
	if link == "" || data["hasRegistrationKey"] != true || data["qrCode"] == nil || data["registrationKey"] != nil {
		t.Fatal("invalid public pairing response")
	}
	status, body = call(t, ts, http.MethodPut, "/api/remote/relay", "test-key", map[string]any{"enabled": false})
	if status != 200 || body["data"].(map[string]any)["pairingLink"] != nil {
		t.Fatal(body)
	}
	status, body = call(t, ts, http.MethodPut, "/api/remote/relay", "test-key", map[string]any{"enabled": true})
	if status != 200 || body["data"].(map[string]any)["pairingLink"] != link {
		t.Fatal("disabling lost pairing identity")
	}
	status, body = call(t, ts, http.MethodPost, "/api/remote/relay/reset-pairing", "test-key", nil)
	if status != 200 || body["data"].(map[string]any)["pairingLink"] == link {
		t.Fatal("pairing not rotated")
	}
	for _, payload := range []string{`null`, `{"enabled":false} {"enabled":true}`, `{"unexpected":true}`} {
		req, err := http.NewRequest(http.MethodPut, ts.URL+"/api/remote/relay", strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Loopra-Key", "test-key")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("invalid config accepted: %s", payload)
		}
	}
	for _, method := range []string{http.MethodPut, http.MethodPost} {
		path := "/api/remote/relay"
		if method == http.MethodPost {
			path += "/reset-pairing"
		}
		status, _ := call(t, ts, method, path, "", map[string]any{})
		if status != 401 {
			t.Fatal("pairing mutation not protected", status)
		}
	}
}

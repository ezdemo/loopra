package controller

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMobileRelayUsesWorkbenchRouterAndKeepsAuthentication(t *testing.T) {
	s, _, err := New(nil, Options{Home: t.TempDir(), AccessKey: "desktop-only-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	router := NewRouter(s)
	mobile := s.MobileRelayHost()
	for _, check := range []struct {
		method, path string
		code         int
	}{
		{"GET", "/api/mobile/handshake", 200},
		{"HEAD", "/api/mobile/handshake", 200},
		{"POST", "/api/mobile/handshake", 405},
		{"GET", "/api/system/health", 200},
		{"GET", "/api/not-found", 404},
		{"GET", "/config.json", 400},
		{"GET", "https://example.org/api/system/health", 400},
	} {
		request := httptest.NewRequest(check.method, check.path, nil)
		// Test requests normally have an absolute URL; the tunnel only accepts
		// relative API targets, exactly like a browser's origin-form request.
		if !strings.HasPrefix(check.path, "https:") {
			request.URL.Scheme, request.URL.Host = "", ""
		}
		request.Header.Set("X-Loopra-Key", "untrusted-phone-value")
		response := httptest.NewRecorder()
		mobile.ServeHTTP(response, request)
		if response.Code != check.code {
			t.Fatalf("%s %s: %d %s", check.method, check.path, response.Code, response.Body.String())
		}
		if check.path == "/api/mobile/handshake" && check.method == "GET" {
			var body struct {
				Success bool `json:"success"`
				Data    struct {
					Protocol string `json:"protocol"`
					Version  int    `json:"version"`
				} `json:"data"`
			}
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.Success || body.Data.Protocol != "loopra-relay" || body.Data.Version != 1 {
				t.Fatal(response.Body.String())
			}
		}
		if strings.Contains(response.Body.String(), "desktop-only-key") {
			t.Fatal("desktop access key leaked")
		}
	}
	unauthenticated := httptest.NewRecorder()
	router.ServeHTTP(unauthenticated, httptest.NewRequest("GET", "/api/system/health", nil))
	if unauthenticated.Code != 401 {
		t.Fatal("ordinary HTTP authentication was bypassed")
	}
}

func TestMobileRelayReturnsNotReadyUntilRouterIsBound(t *testing.T) {
	host := &mobileRelayHost{key: "fixture"}
	response := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/api/system/health", nil)
	request.URL.Scheme, request.URL.Host = "", ""
	host.ServeHTTP(response, request)
	if response.Code != 503 {
		t.Fatal(response.Code)
	}
}

package controller

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gogf/gf/v2/net/ghttp"
)

func TestCanonicalSlashRedirects(t *testing.T) {
	server, key := newTestServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	for _, route := range []struct{ method, path, target string }{
		{http.MethodGet, "/api/version?probe=1", "/api/version/?probe=1"},
		{http.MethodPost, "/api/git?probe=1", "/api/git/?probe=1"},
		{http.MethodPut, "/api/pets?probe=1", "/api/pets/?probe=1"},
	} {
		request, _ := http.NewRequest(route.method, server.URL+route.path, nil)
		request.Header.Set("X-Loopra-Key", key)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusMovedPermanently || response.Header.Get("Location") != route.target {
			t.Fatalf("%s %s: status=%d, location=%q", route.method, route.path, response.StatusCode, response.Header.Get("Location"))
		}
	}
}

func TestErrorsKeepAuthenticationAndResponseContract(t *testing.T) {
	api, key, err := New(nil, Options{Home: t.TempDir(), AccessKey: "fixture-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	router := NewRouter(api)
	router.BindHandler("GET:/api/fixture/panic", func(*ghttp.Request) {
		panic("private error details")
	})
	server := httptest.NewServer(router)
	defer server.Close()
	for _, test := range []struct {
		method string
		path   string
		key    string
		code   int
	}{
		{http.MethodGet, "/api/fixture/panic", "", http.StatusUnauthorized},
		{http.MethodGet, "/api/fixture/panic", key, http.StatusInternalServerError},
		{http.MethodPost, "/api/system/health", key, http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/unknown/path", key, http.StatusNotFound},
	} {
		request, _ := http.NewRequest(test.method, server.URL+test.path, nil)
		request.Header.Set("X-Loopra-Key", test.key)
		request.Header.Set("Origin", "https://frontend.invalid")
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != test.code {
			t.Fatalf("%s %s = %d, body=%s", test.method, test.path, response.StatusCode, body)
		}
		if response.Header.Get("Access-Control-Allow-Origin") != "https://frontend.invalid" {
			t.Fatal("error response lost CORS headers")
		}
		if test.code == http.StatusInternalServerError && (!strings.Contains(string(body), `"success":false`) || strings.Contains(string(body), "private error details")) {
			t.Fatalf("panic response = %s", body)
		}
	}
}

func TestPathValuesAreDecodedExactlyOnce(t *testing.T) {
	api, key, err := New(nil, Options{Home: t.TempDir(), AccessKey: "fixture-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	router := NewRouter(api)
	router.BindHandler("GET:/api/fixture/:name", api.action(func(_ *Controller, w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.PathValue("name"))
	}))
	server := httptest.NewServer(router)
	defer server.Close()
	for _, test := range []struct{ path, name string }{
		{"/api/fixture/a%2Fb", "a/b"},
		{"/api/fixture/a%252Fb", "a%2Fb"},
		{"/api/fixture/a%20b", "a b"},
	} {
		request, _ := http.NewRequest(http.MethodGet, server.URL+test.path, nil)
		request.Header.Set("X-Loopra-Key", key)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || string(body) != test.name {
			t.Fatalf("%s: status=%d, name=%q", test.path, response.StatusCode, body)
		}
	}
}

func TestMethodGuardDistinguishes405From404(t *testing.T) {
	server, key := newTestServer(t)
	for _, test := range []struct {
		method string
		path   string
		code   int
		allow  string
	}{
		{http.MethodGet, "/api/chat/stream", http.StatusMethodNotAllowed, "POST"},
		{http.MethodPost, "/api/does-not-exist", http.StatusNotFound, ""},
		{http.MethodPut, "/api/git/status", http.StatusMethodNotAllowed, "GET, HEAD, POST"},
		{http.MethodDelete, "/api/config", http.StatusMethodNotAllowed, "GET, HEAD, PUT"},
	} {
		request, _ := http.NewRequest(test.method, server.URL+test.path, nil)
		request.Header.Set("X-Loopra-Key", key)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != test.code {
			t.Fatalf("%s %s = %d, body=%s", test.method, test.path, response.StatusCode, body)
		}
		if got := response.Header.Get("Allow"); got != test.allow {
			t.Fatalf("%s %s Allow = %q, want %q", test.method, test.path, got, test.allow)
		}
	}
}

func TestHandlerWritten500IsNotDuplicated(t *testing.T) {
	api, key, err := New(nil, Options{Home: t.TempDir(), AccessKey: "fixture-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	router := NewRouter(api)
	router.BindHandler("GET:/api/fixture/fail", func(r *ghttp.Request) {
		withResponseWriter(r, func(w http.ResponseWriter) {
			writeFail(w, http.StatusInternalServerError, "boom")
		})
	})
	server := httptest.NewServer(router)
	defer server.Close()

	request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/fixture/fail", nil)
	request.Header.Set("X-Loopra-Key", key)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}
	if count := strings.Count(string(body), `"success":false`); count != 1 {
		t.Fatalf("expected exactly one envelope, got %d: %s", count, body)
	}
	if !strings.Contains(string(body), `"error":"boom"`) {
		t.Fatalf("handler envelope was replaced: %s", body)
	}
}

package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gogf/gf/v2/net/ghttp"
)

func mappingTestServer(t *testing.T) (*Controller, *ghttp.Server, *apiRouter, string) {
	t.Helper()
	controller, key, err := New(nil, Options{Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = controller.Close() })
	server := NewRouter(controller)
	return controller, server, newAPIRouter(controller, server, "/api"), key
}

func TestReadRouteExposesGetAndHead(t *testing.T) {
	_, server, api, key := mappingTestServer(t)
	calls := 0
	readRoute(api, "/resource", func(*ghttp.Request) {
		calls++
	})
	api.flush()

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, "/api/resource", nil)
		request.Header.Set("X-Loopra-Key", key)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", method, response.Code)
		}
	}
	if calls != 2 {
		t.Fatalf("handler calls = %d, want one per mapped method", calls)
	}
}

func TestMappingNormalizesTrailingSlashAndKeepsFirstHandler(t *testing.T) {
	_, server, api, key := mappingTestServer(t)
	first, second := 0, 0
	api.GET("/mapping-probe/", func(*ghttp.Request) { first++ })
	api.GET("/mapping-probe", func(*ghttp.Request) { second++ })
	api.flush()

	for _, probe := range []struct {
		path  string
		first int
		slash bool
	}{
		{"/api/mapping-probe", 0, false},
		{"/api/mapping-probe/", 1, true},
	} {
		request := httptest.NewRequest(http.MethodGet, probe.path, nil)
		request.Header.Set("X-Loopra-Key", key)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if probe.slash && first != 1 {
			t.Fatalf("%s should dispatch the slash handler, first=%d second=%d", probe.path, first, second)
		}
		if !probe.slash && second != 1 {
			t.Fatalf("%s should dispatch the exact handler, first=%d second=%d", probe.path, first, second)
		}
	}
}

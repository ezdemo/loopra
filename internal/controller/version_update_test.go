package controller

import (
	"net/http"
	"testing"
)

func TestVersionUpdateIdle(t *testing.T) {
	ts, key := newTestServer(t)
	_, env := call(t, ts, http.MethodGet, "/api/version/update", key, nil)
	data := env["data"].(map[string]any)
	if data["running"] != false || data["state"] != "idle" {
		t.Fatalf("update status = %v", data)
	}
	code, env := call(t, ts, http.MethodPost, "/api/version/update/stop", key, nil)
	if code != http.StatusBadRequest || env["success"] != false {
		t.Fatalf("stop = %d %v", code, env)
	}
}

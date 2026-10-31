package controller

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestContextLensPanelTicketAndLifecycle(t *testing.T) {
	ts, key, _, _ := parityServer(t, "")
	code, env := call(t, ts, "GET", "/api/plugins", key, nil)
	if code != 200 {
		t.Fatal(env)
	}
	row := pluginRow(env["data"].([]any), "context_lens")
	if row == nil || row["panel"].(map[string]any)["title"] != "透镜" || row["sidebar"] != nil {
		t.Fatalf("panel=%v", row)
	}
	code, env = call(t, ts, "POST", "/api/plugins/context_lens/panel/open", key, map[string]any{})
	if code != 200 {
		t.Fatalf("open=%d %v", code, env)
	}
	path := env["data"].(map[string]any)["page"].(string)
	page, err := http.Get(ts.URL + "/api" + path)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if page.StatusCode != 200 || !strings.Contains(string(raw), "上下文透镜") || !strings.Contains(page.Header.Get("Content-Security-Policy"), "connect-src 'none'") {
		t.Fatalf("page=%d %s", page.StatusCode, raw)
	}
	asset, err := http.Get(ts.URL + "/api" + path + "app.js")
	if err != nil {
		t.Fatal(err)
	}
	asset.Body.Close()
	if asset.StatusCode != 200 {
		t.Fatalf("asset=%d", asset.StatusCode)
	}
	denied, err := http.Get(ts.URL + "/api/plugins/context_lens/panel/")
	if err != nil {
		t.Fatal(err)
	}
	denied.Body.Close()
	if denied.StatusCode != 401 {
		t.Fatalf("anonymous panel=%d", denied.StatusCode)
	}
	call(t, ts, "POST", "/api/plugins/context_lens/toggle", key, map[string]any{"enabled": false})
	_, env = call(t, ts, "GET", "/api/plugins", key, nil)
	if pluginRow(env["data"].([]any), "context_lens")["panel"] != nil {
		t.Fatal("disabled plugin retained its panel tab")
	}
}

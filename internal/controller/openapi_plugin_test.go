package controller

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenapiPluginToolsAndPageBridge(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/spec" {
			io.WriteString(w, `{"openapi":"3.0.3","paths":{"/ping":{"get":{"operationId":"ping","summary":"测试接口"}}}}`)
			return
		}
		io.WriteString(w, `{"pong":true}`)
	}))
	defer upstream.Close()
	ts, key, s, _ := parityServer(t, "")
	_, env := call(t, ts, "GET", "/api/plugins", key, nil)
	row := pluginRow(env["data"].([]any), "openapi")
	if row == nil || row["settings"] != true || row["menu"] == nil || row["enabled"] != true {
		t.Fatalf("plugin=%v", row)
	}
	if row["menu"].(map[string]any)["category"] != "工具与集成" {
		t.Fatal("OpenAPI menu category was lost")
	}
	menuIcon := row["menu"].(map[string]any)["icon"].(map[string]any)
	if menuIcon["hidden"] != true || row["icon"].(map[string]any)["name"] != "braces" {
		t.Fatal("OpenAPI must hide only its menu icon")
	}
	for _, name := range []string{"search_apis", "get_api_detail", "call_api"} {
		if !toolListed(t, ts, key, name) {
			t.Fatalf("missing registered tool %s", name)
		}
	}
	source := map[string]any{"docUrl": upstream.URL + "/spec"}
	code, env := call(t, ts, "POST", "/api/plugins/openapi/request", key, map[string]any{"action": "save", "value": source})
	if code != 200 || env["success"] != true {
		t.Fatalf("save=%d %v", code, env)
	}
	bound := s.plugins.Bound()
	for _, tool := range bound {
		switch tool.Name {
		case "search_apis":
			out, err := tool.Call(context.Background(), map[string]any{"keyword": "测试"})
			if err != nil || len(out["results"].([]map[string]any)) != 1 {
				t.Fatalf("search=%v %v", out, err)
			}
		case "get_api_detail", "call_api":
			if tool.Name == "call_api" && tool.ReadOnly {
				t.Fatal("API execution must use the approval policy")
			}
			out, err := tool.Call(context.Background(), map[string]any{"docUrl": upstream.URL + "/spec", "method": "GET", "path": "/ping"})
			if err != nil || out == nil {
				t.Fatalf("%s=%v %v", tool.Name, out, err)
			}
		}
	}
	code, _ = call(t, ts, "POST", "/api/plugins/openapi/request", key, map[string]any{"action": "call", "value": map[string]any{}})
	if code != 400 {
		t.Fatal("page bridge allowed API execution")
	}
	code, _ = call(t, ts, "POST", "/api/plugins/web/request", key, map[string]any{"action": "sources"})
	if code != 400 {
		t.Fatal("another plugin accessed OpenAPI service")
	}
	call(t, ts, "POST", "/api/plugins/openapi/toggle", key, map[string]any{"enabled": false})
	if toolListed(t, ts, key, "call_api") {
		t.Fatal("disabled plugin retained tools")
	}
	_, env = call(t, ts, "GET", "/api/plugins", key, nil)
	row = pluginRow(env["data"].([]any), "openapi")
	if row["menu"] != nil {
		t.Fatal("disabled plugin retained menu")
	}
	code, _ = call(t, ts, "POST", "/api/plugins/openapi/request", key, map[string]any{"action": "sources"})
	if code != 400 {
		t.Fatal("disabled plugin bridge remained active")
	}
	call(t, ts, "POST", "/api/plugins/openapi/toggle", key, map[string]any{"enabled": true})
	code, env = call(t, ts, "POST", "/api/plugins/openapi/request", key, map[string]any{"action": "sources"})
	if code != 200 || len(env["data"].([]any)) != 1 {
		t.Fatal("plugin toggle lost source configuration")
	}
}

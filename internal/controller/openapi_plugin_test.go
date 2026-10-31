package controller

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/testutil"
)

func TestOpenapiPluginToolsAndPageBridge(t *testing.T) {
	pluginDir := testutil.ExternalPlugin(t, "openapi")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/spec" {
			io.WriteString(w, `{"openapi":"3.0.3","paths":{"/ping":{"get":{"operationId":"ping","summary":"测试接口"}}}}`)
			return
		}
		io.WriteString(w, `{"pong":true}`)
	}))
	defer upstream.Close()
	ts, key, s, _ := parityServer(t, "")
	code, installed := call(t, ts, "POST", "/api/plugins/install", key, map[string]any{"source": pluginDir})
	if code != http.StatusOK {
		t.Fatalf("install external OpenAPI plugin = %d %v", code, installed)
	}
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
	code, env = call(t, ts, "POST", "/api/plugins/openapi/request", key, map[string]any{"action": "save", "value": source})
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

func TestThirdPartyPageBackendAndDeclaredOpenAPIService(t *testing.T) {
	ts, key, _, _ := parityServer(t, "")
	dir := t.TempDir()
	for file, source := range map[string]string{
		"package.json": `{"name":"business-page","loopra":{"plugin":"plugin.js","services":["openapi"]}}`,
		"plugin.js": `export async function onRequest(input) {
  if (input.action === "sources") return loopra.services.request("openapi", "sources", {});
  if (input.action !== "echo") throw new Error("unknown action");
  return { value: input.value, config: input.config, context: input.context };
}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	code, env := call(t, ts, "POST", "/api/plugins/install", key, map[string]any{"source": dir})
	if code != 200 || env["data"].(map[string]any)["requests"] != true {
		t.Fatalf("install=%d %v", code, env)
	}
	call(t, ts, "POST", "/api/plugins/business_page/config", key, map[string]any{"focus": "orders"})
	code, env = call(t, ts, "POST", "/api/plugins/business_page/request", key, map[string]any{
		"action": "echo", "value": map[string]any{"plugin": "openapi"}, "config": map[string]any{"focus": "forged"},
		"context": map[string]any{"workspaceHash": "project", "sessionId": "project/session"},
	})
	if code != 200 {
		t.Fatalf("request=%d %v", code, env)
	}
	data := env["data"].(map[string]any)
	if data["config"].(map[string]any)["focus"] != "orders" || data["context"].(map[string]any)["sessionId"] != "project/session" {
		t.Fatalf("payload=%v", data)
	}
	code, env = call(t, ts, "POST", "/api/plugins/business_page/request", key, map[string]any{"action": "sources"})
	if code != 200 {
		t.Fatalf("declared host service=%d %v", code, env)
	}
	code, _ = call(t, ts, "POST", "/api/plugins/business_page/request", "", map[string]any{"action": "echo"})
	if code != 401 {
		t.Fatalf("unauthenticated request=%d", code)
	}
	code, _ = call(t, ts, "POST", "/api/plugins/business_page/request", key, map[string]any{"action": "call_api"})
	if code != 400 {
		t.Fatalf("unknown action=%d", code)
	}
	call(t, ts, "POST", "/api/plugins/business_page/toggle", key, map[string]any{"enabled": false})
	code, _ = call(t, ts, "POST", "/api/plugins/business_page/request", key, map[string]any{"action": "echo"})
	if code != 400 {
		t.Fatalf("disabled page=%d", code)
	}
}

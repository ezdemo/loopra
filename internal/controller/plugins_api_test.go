package controller

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/service/plugin"

	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestPluginHTTPInstall(t *testing.T) {
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	registry := tools.NewRegistry()
	a, err := agentpkg.New(home, "plugin01", &cfg, agentpkg.Options{Toolsets: []tool.Toolset{registry}})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: home, Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	archive := pluginTarGz(map[string]string{
		"package/package.json": `{"name":"greeter","version":"1.0.0","description":"hi","loopra":"./plugin.js"}`,
		"package/plugin.js": `export function tools() {
  return [{ name: "greet", description: "say hi", readOnly: true, parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];
}
export function call(input) { return { text: "hello " + input.args.name }; }
`,
	})
	srv.plugins.Fetcher = func(ctx context.Context, rawURL string) ([]byte, error) {
		switch {
		case strings.Contains(rawURL, "/greeter/1.0.0"):
			return []byte(`{"version":"1.0.0","dist":{"tarball":"https://registry.npmjs.org/greeter/-/greeter-1.0.0.tgz"}}`), nil
		case strings.Contains(rawURL, "greeter-1.0.0.tgz"):
			return archive, nil
		default:
			return nil, fmt.Errorf("unexpected %s", rawURL)
		}
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	code, env := call(t, ts, http.MethodPost, "/api/plugins/install", key, map[string]string{"source": "https://example.com/old.jar"})
	if code != http.StatusBadRequest || env["success"] != false {
		t.Fatalf("jar install = %d %v", code, env["error"])
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/install", key, map[string]string{"source": "greeter@1.0.0"})
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("install = %d %v", code, env["error"])
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins", key, nil)
	if code != http.StatusOK {
		t.Fatal(env)
	}
	items, _ := env["data"].([]any)
	if pluginRow(items, "greeter") == nil {
		t.Fatalf("plugins = %v", env["data"])
	}
	if !toolListed(t, ts, key, "greeter__greet") {
		t.Fatal("plugin tool was not registered")
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/greeter/toggle", key, map[string]any{"enabled": false})
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("toggle = %d %v", code, env)
	}
	if toolListed(t, ts, key, "greeter__greet") {
		t.Fatal("disabled plugin tool still registered")
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/greeter/remove", key, map[string]any{})
	if code != http.StatusOK || env["data"] != "插件已卸载: greeter" {
		t.Fatalf("remove = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins", key, nil)
	items, _ = env["data"].([]any)
	if code != http.StatusOK || pluginRow(items, "greeter") != nil {
		t.Fatalf("list after remove = %v", env["data"])
	}
	code, _ = call(t, ts, http.MethodPost, "/api/extpacks/install", key, map[string]string{"source": "greeter"})
	if code != http.StatusBadRequest {
		t.Fatalf("extpack install = %d", code)
	}
}

func pluginRow(items []any, id string) map[string]any {
	for _, item := range items {
		row, _ := item.(map[string]any)
		if row["id"] == id {
			return row
		}
	}
	return nil
}

func toolListed(t *testing.T, ts *httptest.Server, key, name string) bool {
	t.Helper()
	_, env := call(t, ts, http.MethodGet, "/api/tools", key, nil)
	items, _ := env["data"].([]any)
	for _, item := range items {
		row, _ := item.(map[string]any)
		if row["name"] == name {
			return true
		}
	}
	return false
}

func pluginTarGz(files map[string]string) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			panic(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			panic(err)
		}
	}
	_ = tw.Close()
	_ = zw.Close()
	return buf.Bytes()
}

func TestPluginSettingsPage(t *testing.T) {
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "settingsdemo")
	if err := os.MkdirAll(filepath.Join(dir, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"package.json":  `{"name":"settingsdemo","version":"1.0.0","description":"settings","loopra":{"plugin":"./plugin.js","ui":{"settings":"./ui/index.html"}}}`,
		"plugin.js":     "export const meta = { displayName: \"设置示例\" };\nexport function systemPrompt() { return {}; }\n// secret-module-body\n",
		"ui/index.html": `<!doctype html><title>settings</title>settings-page-ok`,
		"ui/note.txt":   "hidden-note",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	registry := tools.NewRegistry()
	a, err := agentpkg.New(home, "pluginui1", &cfg, agentpkg.Options{Toolsets: []tool.Toolset{registry}})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: home, Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	code, env := call(t, ts, http.MethodPost, "/api/plugins/install", key, map[string]string{"source": dir})
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("install = %d %v", code, env["error"])
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins", key, nil)
	items, _ := env["data"].([]any)
	row := pluginRow(items, "settingsdemo")
	if row == nil || row["settings"] != true {
		t.Fatalf("settings row = %#v", row)
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/settingsdemo/toggle", key, map[string]any{"enabled": false})
	if code != http.StatusOK {
		t.Fatalf("disable = %d %v", code, env["error"])
	}

	openReq, err := http.NewRequest(http.MethodPost, ts.URL+"/api/plugins/settingsdemo/ui/open", nil)
	if err != nil {
		t.Fatal(err)
	}
	openReq.Header.Set("X-Loopra-Key", key)
	openResp, err := ts.Client().Do(openReq)
	if err != nil {
		t.Fatal(err)
	}
	openBody, _ := io.ReadAll(openResp.Body)
	openResp.Body.Close()
	if openResp.StatusCode != http.StatusOK {
		t.Fatalf("open = %d %s", openResp.StatusCode, openBody)
	}
	var ticket *http.Cookie
	for _, cookie := range openResp.Cookies() {
		if cookie.Name == plugin.UICookie {
			ticket = cookie
		}
	}
	if ticket == nil || !ticket.HttpOnly || ticket.Path != "/api/plugins/settingsdemo/ui" || ticket.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie = %#v", ticket)
	}
	if strings.Contains(string(openBody), ticket.Value) {
		t.Fatal("ticket leaked into the response body")
	}

	denied, err := http.Get(ts.URL + "/api/plugins/settingsdemo/ui/")
	if err != nil {
		t.Fatal(err)
	}
	denied.Body.Close()
	if denied.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous ui = %d", denied.StatusCode)
	}

	pageReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/settingsdemo/ui/", nil)
	if err != nil {
		t.Fatal(err)
	}
	pageReq.AddCookie(ticket)
	pageResp, err := ts.Client().Do(pageReq)
	if err != nil {
		t.Fatal(err)
	}
	pageBody, _ := io.ReadAll(pageResp.Body)
	pageResp.Body.Close()
	if pageResp.StatusCode != http.StatusOK || !strings.Contains(string(pageBody), "settings-page-ok") {
		t.Fatalf("page = %d %s", pageResp.StatusCode, pageBody)
	}
	if !strings.Contains(pageResp.Header.Get("Content-Security-Policy"), "connect-src 'none'") || strings.Contains(string(pageBody), key) {
		t.Fatalf("policy = %s", pageResp.Header.Get("Content-Security-Policy"))
	}

	otherReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/chat_neko/ui/", nil)
	if err != nil {
		t.Fatal(err)
	}
	otherReq.AddCookie(ticket)
	otherResp, err := ts.Client().Do(otherReq)
	if err != nil {
		t.Fatal(err)
	}
	otherResp.Body.Close()
	if otherResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cross plugin = %d", otherResp.StatusCode)
	}

	noteReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/settingsdemo/ui/note.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	noteReq.Header.Set("X-Loopra-Key", key)
	noteResp, err := ts.Client().Do(noteReq)
	if err != nil {
		t.Fatal(err)
	}
	noteBody, _ := io.ReadAll(noteResp.Body)
	noteResp.Body.Close()
	if noteResp.StatusCode == http.StatusOK || strings.Contains(string(noteBody), "hidden-note") {
		t.Fatalf("note = %d %s", noteResp.StatusCode, noteBody)
	}
	escapeReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/settingsdemo/ui/../plugin.js", nil)
	if err != nil {
		t.Fatal(err)
	}
	escapeReq.Header.Set("X-Loopra-Key", key)
	escapeResp, err := ts.Client().Do(escapeReq)
	if err != nil {
		t.Fatal(err)
	}
	escapeBody, _ := io.ReadAll(escapeResp.Body)
	escapeResp.Body.Close()
	if strings.Contains(string(escapeBody), "secret-module-body") {
		t.Fatal("plugin source leaked")
	}

	code, env = call(t, ts, http.MethodPost, "/api/plugins/settingsdemo/config", key, map[string]any{"nickname": "主人"})
	data, _ := env["data"].(map[string]any)
	if code != http.StatusOK || data["nickname"] != "主人" {
		t.Fatalf("save config = %d %#v", code, env)
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins/settingsdemo/config", key, nil)
	data, _ = env["data"].(map[string]any)
	if code != http.StatusOK || data["nickname"] != "主人" {
		t.Fatalf("get config = %d %#v", code, env)
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/settingsdemo/config", key, []any{1})
	if code != http.StatusBadRequest {
		t.Fatalf("array config = %d %v", code, env["error"])
	}
}

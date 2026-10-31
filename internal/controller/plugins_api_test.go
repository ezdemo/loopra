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

	// Browse a repository with multiple plugins, install just one, and keep it
	// installed when the source subscription is removed.
	srv.plugins.Fetcher = func(ctx context.Context, rawURL string) ([]byte, error) {
		if !strings.Contains(rawURL, "codeload.github.com/acme/plugins/") {
			return nil, fmt.Errorf("unexpected %s", rawURL)
		}
		return pluginTarGz(map[string]string{
			"repo/plugins/one/package.json": `{"name":"source-one","loopra":"plugin.js"}`,
			"repo/plugins/one/plugin.js":    `export function ping() { return { text: "one" }; }`,
			"repo/plugins/two/package.json": `{"name":"source-two","loopra":"plugin.js"}`,
			"repo/plugins/two/plugin.js":    `export function ping() { return { text: "two" }; }`,
		}), nil
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/sources", key, map[string]string{"source": "github:acme/plugins"})
	if code != http.StatusOK {
		t.Fatalf("add source = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins/sources", key, nil)
	if code != http.StatusOK || !strings.Contains(fmt.Sprint(env["data"]), "https://github.com/acme/plugins") {
		t.Fatalf("list sources = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins/catalog?source=github%3Aacme%2Fplugins", key, nil)
	items, _ = env["data"].([]any)
	if code != http.StatusOK || len(items) != 2 {
		t.Fatalf("catalog = %d %v", code, env)
	}
	row := pluginRow(items, "source_one")
	if row == nil {
		t.Fatal("source_one missing from catalog")
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/install", key, map[string]any{"source": row["source"]})
	if code != http.StatusOK || !toolListed(t, ts, key, "source_one__ping") || toolListed(t, ts, key, "source_two__ping") {
		t.Fatalf("install catalog entry = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/sources/remove", key, map[string]string{"source": "github:acme/plugins"})
	if code != http.StatusOK || !toolListed(t, ts, key, "source_one__ping") {
		t.Fatalf("remove source = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/source_one/uninstall", key, nil)
	if code != http.StatusOK || toolListed(t, ts, key, "source_one__ping") {
		t.Fatalf("uninstall catalog entry = %d %v", code, env)
	}
	code, _ = call(t, ts, http.MethodGet, "/api/plugins/catalog?source=left-pad", key, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("non-repository catalog = %d", code)
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
		"package.json":  `{"name":"settingsdemo","version":"1.0.0","description":"settings","loopra":{"plugin":"./plugin.js","icon":"./ui/icon.svg","ui":{"settings":"./ui/index.html","sidebar":{"title":"侧栏","icon":"cat","page":"./ui/index.html"},"menu":{"title":"菜单","icon":"cat","children":[{"id":"nickname","title":"称呼","page":"./ui/index.html"}]}}}}`,
		"plugin.js":     "export const meta = { displayName: \"设置示例\" };\nexport function systemPrompt() { return {}; }\n// secret-module-body\n",
		"ui/index.html": `<!doctype html><title>settings</title>settings-page-ok`,
		"ui/app.css":    "body{color:red}",
		"ui/icon.svg":   `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
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
	var side, menu, icon map[string]any
	if row != nil {
		side, _ = row["sidebar"].(map[string]any)
		menu, _ = row["menu"].(map[string]any)
		icon, _ = row["icon"].(map[string]any)
	}
	if row == nil || row["settings"] != true || side["title"] != "侧栏" || menu["title"] != "菜单" || icon["key"] != "plugin" {
		t.Fatalf("settings row = %#v", row)
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/settingsdemo/toggle", key, map[string]any{"enabled": false})
	if code != http.StatusOK {
		t.Fatalf("disable = %d %v", code, env["error"])
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins", key, nil)
	items, _ = env["data"].([]any)
	row = pluginRow(items, "settingsdemo")
	if row == nil || row["settings"] != true || row["sidebar"] != nil || row["menu"] != nil {
		t.Fatalf("disabled row = %#v", row)
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
	if !strings.Contains(string(openBody), "/plugins/settingsdemo/ui/t/"+ticket.Value+"/") || strings.Contains(string(openBody), key) {
		t.Fatalf("open = %s", openBody)
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
	tokenPage, err := http.Get(ts.URL + "/api/plugins/settingsdemo/ui/t/" + ticket.Value + "/")
	if err != nil {
		t.Fatal(err)
	}
	tokenBody, _ := io.ReadAll(tokenPage.Body)
	tokenPage.Body.Close()
	if tokenPage.StatusCode != http.StatusOK || !strings.Contains(string(tokenBody), "settings-page-ok") || !strings.Contains(string(tokenBody), plugin.UIBridgeRel) {
		t.Fatalf("token page = %d %s", tokenPage.StatusCode, tokenBody)
	}
	if !strings.Contains(tokenPage.Header.Get("Content-Security-Policy"), "/api/plugins/settingsdemo/ui/t/"+ticket.Value+"/") || strings.Contains(tokenPage.Header.Get("Content-Security-Policy"), "allow-same-origin") {
		t.Fatalf("token policy = %s", tokenPage.Header.Get("Content-Security-Policy"))
	}
	cssResp, err := http.Get(ts.URL + "/api/plugins/settingsdemo/ui/t/" + ticket.Value + "/app.css")
	if err != nil {
		t.Fatal(err)
	}
	cssBody, _ := io.ReadAll(cssResp.Body)
	cssResp.Body.Close()
	if cssResp.StatusCode != http.StatusOK || string(cssBody) != "body{color:red}" || cssResp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("css = %d %s", cssResp.StatusCode, cssBody)
	}
	bridgeResp, err := http.Get(ts.URL + "/api/plugins/settingsdemo/ui/t/" + ticket.Value + "/" + plugin.UIBridgeRel)
	if err != nil {
		t.Fatal(err)
	}
	bridgeBody, _ := io.ReadAll(bridgeResp.Body)
	bridgeResp.Body.Close()
	if bridgeResp.StatusCode != http.StatusOK || !strings.Contains(string(bridgeBody), ":where(button)") {
		t.Fatalf("bridge = %d %s", bridgeResp.StatusCode, bridgeBody)
	}
	crossed, err := http.Get(ts.URL + "/api/plugins/chat_neko/ui/t/" + ticket.Value + "/")
	if err != nil {
		t.Fatal(err)
	}
	crossed.Body.Close()
	if crossed.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token crossed plugins = %d", crossed.StatusCode)
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

	sideOpen, err := http.NewRequest(http.MethodPost, ts.URL+"/api/plugins/settingsdemo/sidebar/open", nil)
	if err != nil {
		t.Fatal(err)
	}
	sideOpen.Header.Set("X-Loopra-Key", key)
	sideResp, err := ts.Client().Do(sideOpen)
	if err != nil {
		t.Fatal(err)
	}
	sideResp.Body.Close()
	var sideCookie *http.Cookie
	for _, cookie := range sideResp.Cookies() {
		if cookie.Name == plugin.UICookie {
			sideCookie = cookie
		}
	}
	if sideResp.StatusCode != http.StatusOK || sideCookie == nil || !sideCookie.HttpOnly || sideCookie.Path != "/api/plugins/settingsdemo/sidebar" {
		t.Fatalf("sidebar cookie = %d %#v", sideResp.StatusCode, sideCookie)
	}
	sidePage, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/settingsdemo/sidebar/", nil)
	if err != nil {
		t.Fatal(err)
	}
	sidePage.AddCookie(sideCookie)
	sidePageResp, err := ts.Client().Do(sidePage)
	if err != nil {
		t.Fatal(err)
	}
	sideBody, _ := io.ReadAll(sidePageResp.Body)
	sidePageResp.Body.Close()
	if sidePageResp.StatusCode != http.StatusOK || !strings.Contains(string(sideBody), "settings-page-ok") {
		t.Fatalf("sidebar page = %d %s", sidePageResp.StatusCode, sideBody)
	}
	anonSide, err := http.Get(ts.URL + "/api/plugins/settingsdemo/sidebar/")
	if err != nil {
		t.Fatal(err)
	}
	anonSide.Body.Close()
	if anonSide.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous sidebar = %d", anonSide.StatusCode)
	}

	iconReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/settingsdemo/icons/plugin", nil)
	if err != nil {
		t.Fatal(err)
	}
	iconReq.Header.Set("X-Loopra-Key", key)
	iconResp, err := ts.Client().Do(iconReq)
	if err != nil {
		t.Fatal(err)
	}
	iconBody, _ := io.ReadAll(iconResp.Body)
	iconResp.Body.Close()
	if iconResp.StatusCode != http.StatusOK || !strings.Contains(string(iconBody), "<svg") || !strings.Contains(iconResp.Header.Get("Content-Type"), "image/svg") {
		t.Fatalf("icon = %d %s", iconResp.StatusCode, iconBody)
	}
	anonIcon, err := http.Get(ts.URL + "/api/plugins/settingsdemo/icons/plugin")
	if err != nil {
		t.Fatal(err)
	}
	anonIcon.Body.Close()
	if anonIcon.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous icon = %d", anonIcon.StatusCode)
	}

	menuOpen, err := http.NewRequest(http.MethodPost, ts.URL+"/api/plugins/settingsdemo/menu/open", nil)
	if err != nil {
		t.Fatal(err)
	}
	menuOpen.Header.Set("X-Loopra-Key", key)
	menuResp, err := ts.Client().Do(menuOpen)
	if err != nil {
		t.Fatal(err)
	}
	menuResp.Body.Close()
	var menuCookie *http.Cookie
	for _, cookie := range menuResp.Cookies() {
		if cookie.Name == plugin.UICookie {
			menuCookie = cookie
		}
	}
	if menuResp.StatusCode != http.StatusOK || menuCookie == nil || menuCookie.Path != "/api/plugins/settingsdemo/menu" {
		t.Fatalf("menu cookie = %d %#v", menuResp.StatusCode, menuCookie)
	}
	menuPage, err := http.NewRequest(http.MethodGet, ts.URL+"/api/plugins/settingsdemo/menu/nickname/", nil)
	if err != nil {
		t.Fatal(err)
	}
	menuPage.AddCookie(menuCookie)
	menuPageResp, err := ts.Client().Do(menuPage)
	if err != nil {
		t.Fatal(err)
	}
	menuBody, _ := io.ReadAll(menuPageResp.Body)
	menuPageResp.Body.Close()
	if menuPageResp.StatusCode != http.StatusOK || !strings.Contains(string(menuBody), "settings-page-ok") {
		t.Fatalf("menu page = %d %s", menuPageResp.StatusCode, menuBody)
	}
	menuToken, err := http.Get(ts.URL + "/api/plugins/settingsdemo/menu/t/" + menuCookie.Value + "/nickname/")
	if err != nil {
		t.Fatal(err)
	}
	menuTokenBody, _ := io.ReadAll(menuToken.Body)
	menuToken.Body.Close()
	if menuToken.StatusCode != http.StatusOK || !strings.Contains(string(menuTokenBody), "settings-page-ok") {
		t.Fatalf("menu token = %d %s", menuToken.StatusCode, menuTokenBody)
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

func TestPluginDeclaresSkillAgentAndSchedule(t *testing.T) {
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	registry := tools.NewRegistry()
	a, err := agentpkg.New(home, "contrib01", &cfg, agentpkg.Options{Toolsets: []tool.Toolset{registry}})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: home, Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "src")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	pkg := `{
		"name":"contrib","version":"1.0.0","description":"contrib",
		"loopra":{
			"plugin":"./plugin.js",
			"skill":"./SKILL.md",
			"subagent":{"name":"复查","description":"只读","readOnly":true,"instructions":"只报告问题。"},
			"schedule":{"name":"每日回顾","message":"总结一下","intervalSec":120}
		}
	}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin.js"), []byte("export function systemPrompt(){ return {} }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: 复查清单\ndescription: 提交前看一遍\n---\n正文\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.plugins.Install(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	code, env := call(t, ts, http.MethodGet, "/api/agent/skills", key, nil)
	if code != http.StatusOK || !skillListed(env["data"], "@plugin-skills/contrib", "复查清单") {
		t.Fatalf("skills = %d %#v", code, env["data"])
	}
	read, err := srv.callExportTool(context.Background(), "skillread", map[string]any{"name": "@plugin-skills/contrib"})
	if err != nil || !strings.Contains(fmt.Sprint(read), "正文") {
		t.Fatalf("skillread = %#v %v", read, err)
	}
	code, env = call(t, ts, http.MethodGet, "/api/sub-agents", key, nil)
	row := profileRow(env["data"], "plugin-contrib")
	if code != http.StatusOK || row == nil || row["plugin"] != true || row["name"] != "复查" {
		t.Fatalf("subagent = %d %#v", code, row)
	}
	code, env = call(t, ts, http.MethodPut, "/api/sub-agents", key, map[string]any{"profiles": []map[string]any{{"id": "plugin-contrib", "name": "改掉", "instructions": "no"}, {"id": "custom1", "name": "Custom", "instructions": "mine"}}})
	if code != http.StatusOK {
		t.Fatalf("put = %d %v", code, env["error"])
	}
	saved, err := os.ReadFile(filepath.Join(home, "sub-agents.json"))
	if err != nil || strings.Contains(string(saved), "plugin-contrib") {
		t.Fatalf("plugin profile was stored: %v %s", err, saved)
	}
	code, env = call(t, ts, http.MethodGet, "/api/sub-agents", key, nil)
	if profileRow(env["data"], "plugin-contrib") == nil || profileRow(env["data"], "custom1") == nil {
		t.Fatalf("after put = %#v", env["data"])
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins/schedules", key, nil)
	items, _ := env["data"].([]any)
	var task map[string]any
	if len(items) > 0 {
		task, _ = items[0].(map[string]any)
	}
	if code != http.StatusOK || task["id"] != "plugin-contrib" || task["plugin"] != true || task["message"] != "总结一下" {
		t.Fatalf("schedules = %d %#v", code, env["data"])
	}
	code, env = call(t, ts, http.MethodPost, "/api/plugins/contrib/toggle", key, map[string]any{"enabled": false})
	if code != http.StatusOK {
		t.Fatalf("disable = %d %v", code, env["error"])
	}
	code, env = call(t, ts, http.MethodGet, "/api/agent/skills", key, nil)
	if skillListed(env["data"], "@plugin-skills/contrib", "复查清单") {
		t.Fatal("disabled skill still listed")
	}
	code, env = call(t, ts, http.MethodGet, "/api/sub-agents", key, nil)
	if profileRow(env["data"], "plugin-contrib") != nil {
		t.Fatal("disabled subagent still listed")
	}
	code, env = call(t, ts, http.MethodGet, "/api/plugins/schedules", key, nil)
	if items, _ = env["data"].([]any); code != http.StatusOK || len(items) != 0 {
		t.Fatalf("disabled schedules = %d %#v", code, env["data"])
	}
}

func skillListed(data any, scope, name string) bool {
	items, _ := data.([]any)
	for _, item := range items {
		row, _ := item.(map[string]any)
		if row["scope"] == scope && row["name"] == name {
			return true
		}
	}
	return false
}

func profileRow(data any, id string) map[string]any {
	items, _ := data.([]any)
	for _, item := range items {
		row, _ := item.(map[string]any)
		if row["id"] == id {
			return row
		}
	}
	return nil
}

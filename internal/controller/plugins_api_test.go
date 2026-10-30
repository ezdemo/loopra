package controller

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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

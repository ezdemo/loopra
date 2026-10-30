package controller

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func staticTestServer(t *testing.T, withBundle bool) (*httptest.Server, string, string) {
	return newStaticTestServer(t, withBundle, nil)
}

func newStaticTestServer(t *testing.T, withBundle bool, files fs.FS) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	static := filepath.Join(home, "static")
	if withBundle {
		os.MkdirAll(filepath.Join(static, "assets"), 0o755)
		os.WriteFile(filepath.Join(static, "index.html"), []byte("<html>loopra</html>"), 0o644)
		os.WriteFile(filepath.Join(static, "assets", "app.js"), []byte("console.log(1)"), 0o644)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "sta0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home, StaticDir: static, StaticFS: files})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, static
}

func TestStaticServesBundleWithoutKey(t *testing.T) {
	ts, _, _ := staticTestServer(t, true)
	// 不带 X-Loopra-Key：静态资源被豁免（契约 §2）
	resp, err := ts.Client().Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/ status = %d", resp.StatusCode)
	}
	resp, err = ts.Client().Get(ts.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("asset status = %d", resp.StatusCode)
	}
}

func TestStaticSPAFallback(t *testing.T) {
	ts, _, _ := staticTestServer(t, true)
	resp, err := ts.Client().Get(ts.URL + "/settings/general")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deep link status = %d", resp.StatusCode)
	}
}

func TestStaticCachePolicy(t *testing.T) {
	ts, _, _ := staticTestServer(t, true)
	// 资源：可缓存（无 no-store）
	resp, _ := ts.Client().Get(ts.URL + "/assets/app.js")
	resp.Body.Close()
	if resp.Header.Get("Cache-Control") == "no-store" {
		t.Fatal("asset marked no-store")
	}
	// SPA 回退（无扩展名）：动态，no-store
	resp, _ = ts.Client().Get(ts.URL + "/settings")
	resp.Body.Close()
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("deep link cache = %q", resp.Header.Get("Cache-Control"))
	}
}

func TestStaticMissingPaths(t *testing.T) {
	// 未安装产物：所有路径均 404，未知 API 仍返回不带 JSON 的 404
	ts, key, _ := staticTestServer(t, false)
	resp, err := ts.Client().Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("/ without bundle = %d", resp.StatusCode)
	}
	// 即使挂载了静态兜底，未知 API 路径仍返回 404
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/nope/deep", nil)
	req.Header.Set("X-Loopra-Key", key)
	resp, err = ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown api = %d", resp.StatusCode)
	}
}

func TestStaticEmbeddedFS(t *testing.T) {
	files := fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<html>embedded</html>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log(1)")},
	}
	ts, _, _ := newStaticTestServer(t, false, files)
	body := getBody(t, ts.URL+"/")
	if !strings.Contains(body, "embedded") {
		t.Fatalf("index = %s", body)
	}
	asset := getBody(t, ts.URL+"/assets/app.js")
	if !strings.Contains(asset, "console.log") {
		t.Fatalf("asset = %s", asset)
	}
	deep := getBody(t, ts.URL+"/settings/general")
	if !strings.Contains(deep, "embedded") {
		t.Fatalf("spa = %s", deep)
	}
}

func TestEmbeddedIgnoresInstalledStatic(t *testing.T) {
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	installed := filepath.Join(home, "static")
	os.MkdirAll(installed, 0o755)
	os.WriteFile(filepath.Join(installed, "index.html"), []byte("<html>installed</html>"), 0o644)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "emb0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>embedded</html>")}}
	srv, _, err := New(a, Options{Home: home, StaticFS: files})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	body := getBody(t, ts.URL+"/")
	if !strings.Contains(body, "embedded") || strings.Contains(body, "installed") {
		t.Fatalf("index = %s", body)
	}
}

func TestStaticDiskOverridesEmbedded(t *testing.T) {
	files := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>embedded</html>")}}
	ts, _, _ := newStaticTestServer(t, true, files)
	body := getBody(t, ts.URL+"/")
	if !strings.Contains(body, "loopra") || strings.Contains(body, "embedded") {
		t.Fatalf("disk index = %s", body)
	}
}

func TestStaticIndexStampsSavedTheme(t *testing.T) {
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	static := filepath.Join(home, "static")
	os.MkdirAll(static, 0o755)
	page := `<!doctype html><html><head><script>window.__LOOPRA_THEME__="";</script></head><body>loopra</body></html>`
	os.WriteFile(filepath.Join(static, "index.html"), []byte(page), 0o644)
	os.WriteFile(filepath.Join(home, "ui-preferences.json"), []byte(`{"theme":"dark"}`), 0o644)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "thm0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, _, err := New(a, Options{Home: home, StaticDir: static})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	body := getBody(t, ts.URL+"/")
	if !strings.Contains(body, `window.__LOOPRA_THEME__="dark"`) || strings.Contains(body, `window.__LOOPRA_THEME__=""`) {
		t.Fatalf("stamped index = %s", body)
	}
	legacy := stampIndexTheme([]byte(`<html><head><title>old</title></head><body>old</body></html>`), "dark")
	if !strings.Contains(string(legacy), `var theme="dark"`) || !strings.Contains(string(legacy), "#191919") {
		t.Fatalf("legacy index = %s", legacy)
	}
	if got := string(stampIndexTheme([]byte(`<html>loopra</html>`), "dark")); got != `<html>loopra</html>` {
		t.Fatalf("page without a head changed: %s", got)
	}
}

func getBody(t *testing.T, url string) string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("%s status = %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

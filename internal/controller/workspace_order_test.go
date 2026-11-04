package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

type listedProject struct{ hash, path string }

func projectRows(t *testing.T, ts *httptest.Server, key string) []listedProject {
	t.Helper()
	code, env := call(t, ts, http.MethodGet, "/api/workspaces", key, nil)
	if code != http.StatusOK {
		t.Fatalf("workspaces = %d, %v", code, env)
	}
	var out []listedProject
	for _, item := range env["data"].([]any) {
		row := item.(map[string]any)
		out = append(out, listedProject{hash: row["hash"].(string), path: row["path"].(string)})
	}
	return out
}

func addProject(t *testing.T, ts *httptest.Server, key, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if code, env := call(t, ts, http.MethodPost, "/api/workspace", key, map[string]any{"path": path}); code != http.StatusOK {
		t.Fatalf("register %s = %d, %v", path, code, env)
	}
	for _, row := range projectRows(t, ts, key) {
		if row.path == path {
			return row.hash
		}
	}
	t.Fatalf("project %s not listed", path)
	return ""
}

func workspaceOrderServer(t *testing.T) (*httptest.Server, string, []string) {
	t.Helper()
	home := t.TempDir()
	root := filepath.Join(home, "defaultWorkSpace")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = root
	a, err := agentpkg.New(home, "ord0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); ts.Close() })
	var hashes []string
	for _, name := range []string{"older", "newer"} {
		hashes = append(hashes, addProject(t, ts, key, filepath.Join(home, name)))
		// createdAt 决定并列时的先后，注册太快会落在同一毫秒。
		time.Sleep(2 * time.Millisecond)
	}
	return ts, key, hashes
}

// 新加的项目没有写进 workspaceOrder，必须排在最上面，而不是沉到列表最底部。
func TestNewProjectSortsToTop(t *testing.T) {
	ts, key, hashes := workspaceOrderServer(t)
	rows := projectRows(t, ts, key)
	if len(rows) != 3 || rows[0].hash != hashes[1] || rows[1].hash != hashes[0] {
		t.Fatalf("newest project should lead: %v", rows)
	}
	saved := []string{hashes[0], hashes[1], rows[2].hash}
	if code, env := call(t, ts, http.MethodPut, "/api/workspaces/order", key, saved); code != http.StatusOK {
		t.Fatalf("save order = %d, %v", code, env)
	}
	added := addProject(t, ts, key, filepath.Join(t.TempDir(), "added"))
	// 已保存的拖拽顺序继续生效，新加的项目插到最前面。
	want := append([]string{added}, saved...)
	after := projectRows(t, ts, key)
	if len(after) != len(want) {
		t.Fatalf("order = %v, want %v", after, want)
	}
	for i, hash := range want {
		if after[i].hash != hash {
			t.Fatalf("order = %v, want %v", after, want)
		}
	}
}

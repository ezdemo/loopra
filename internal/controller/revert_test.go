package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func revertServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "rv00000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, ws
}

func diffOf(before, after string) string {
	var sb strings.Builder
	sb.WriteString("--- a/x\n+++ b/x\n@@ -1,N +1,M @@\n")
	max := len(strings.Split(before, "\n"))
	if a := len(strings.Split(after, "\n")); a > max {
		max = a
	}
	bLines := strings.Split(strings.TrimRight(before, "\n"), "\n")
	aLines := strings.Split(strings.TrimRight(after, "\n"), "\n")
	for i := 0; i < max; i++ {
		if i >= len(bLines) && i >= len(aLines) {
			break
		}
		var b, a string
		if i < len(bLines) {
			b = bLines[i]
		}
		if i < len(aLines) {
			a = aLines[i]
		}
		if b == a {
			sb.WriteString(" " + b + "\n")
		} else {
			if b != "" || i < len(bLines) {
				sb.WriteString("-" + b + "\n")
			}
			if a != "" || i < len(aLines) {
				sb.WriteString("+" + a + "\n")
			}
		}
	}
	return sb.String()
}

func TestFileChangesRevertModifiedFile(t *testing.T) {
	ts, key, ws := revertServer(t)
	path := filepath.Join(ws, "a.txt")
	os.WriteFile(path, []byte("v1\n"), 0o644)
	diff := diffOf("v1\n", "v1 changed\n")
	os.WriteFile(path, []byte("v1 changed\n"), 0o644) // AI 已应用其编辑
	_, env := call(t, ts, http.MethodPost, "/api/sessions/file-changes/revert", key,
		map[string]any{"workspaceHash": "rv00000001", "changes": []map[string]any{
			{"path": "a.txt", "diff": diff, "additions": 1, "deletions": 1},
		}})
	data := env["data"].(map[string]any)
	if data["revertedFiles"].(float64) != 1 {
		t.Fatalf("revert = %v", data)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "v1\n" {
		t.Fatalf("content = %q", got)
	}
}

func TestFileChangesRevertCreatedFileDeletes(t *testing.T) {
	ts, key, ws := revertServer(t)
	path := filepath.Join(ws, "new.txt")
	diff := "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2\n"
	os.WriteFile(path, []byte("line1\nline2\n"), 0o644)
	_, env := call(t, ts, http.MethodPost, "/api/sessions/file-changes/revert", key,
		map[string]any{"workspaceHash": "rv00000001", "changes": []map[string]any{
			{"path": "new.txt", "diff": diff, "created": true, "additions": 2},
		}})
	if env["data"].(map[string]any)["revertedFiles"].(float64) != 1 {
		t.Fatalf("revert = %v", env)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("created file survived revert")
	}
}

func TestFileChangesRevertRefusesDriftedFile(t *testing.T) {
	ts, key, ws := revertServer(t)
	path := filepath.Join(ws, "b.txt")
	os.WriteFile(path, []byte("later edit\n"), 0o644) // 用户在 AI 之后又编辑过
	diff := diffOf("old\n", "ai version\n")
	code, env := call(t, ts, http.MethodPost, "/api/sessions/file-changes/revert", key,
		map[string]any{"workspaceHash": "rv00000001", "changes": []map[string]any{
			{"path": "b.txt", "diff": diff},
		}})
	if code != http.StatusBadRequest || !strings.Contains(env["error"].(string), "后续修改") {
		t.Fatalf("drift check = %d %v", code, env)
	}
	// 没有任何写入
	got, _ := os.ReadFile(path)
	if string(got) != "later edit\n" {
		t.Fatalf("content = %q", got)
	}
}

func TestFileChangesRevertValidation(t *testing.T) {
	ts, key, _ := revertServer(t)
	// 缺少 hash
	code, _ := call(t, ts, http.MethodPost, "/api/sessions/file-changes/revert", key,
		map[string]any{"changes": []any{}})
	if code != http.StatusBadRequest {
		t.Fatal("missing hash accepted")
	}
	// 缺少 diff
	code, _ = call(t, ts, http.MethodPost, "/api/sessions/file-changes/revert", key,
		map[string]any{"workspaceHash": "rv00000001", "changes": []map[string]any{
			{"path": "x.txt"},
		}})
	if code != http.StatusBadRequest {
		t.Fatal("missing diff accepted")
	}
	// 路径穿越尝试
	code, _ = call(t, ts, http.MethodPost, "/api/sessions/file-changes/revert", key,
		map[string]any{"workspaceHash": "rv00000001", "changes": []map[string]any{
			{"path": "../outside.txt", "diff": "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"},
		}})
	if code != http.StatusBadRequest {
		t.Fatal("escape accepted")
	}
}

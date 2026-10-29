package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func subSessServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "subses0001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, home
}

func writeSubLog(t *testing.T, home, parent, id string, lines []string) {
	t.Helper()
	dir := filepath.Join(home, "workspace", "subses0001", "sessions", parent+".sub")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(joinLines(lines)), 0o644)
}

func joinLines(lines []string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}

func TestSubSessionsListAndInfo(t *testing.T) {
	ts, key, home := subSessServer(t)
	writeSubLog(t, home, "main", "sub-abc123", []string{
		`{"type":"sub_start","subSessionId":"sub-abc123","task":"探索：检查路由","name":"探索","title":"检查路由","profile":"explore","startedAt":1770000001000}`,
		`{"type":"sub_content","content":"working"}`,
		`{"type":"sub_end","status":"completed","endedAt":1770000009000}`,
	})
	writeSubLog(t, home, "main", "sub-def456", []string{
		`{"type":"sub_start","subSessionId":"sub-def456","task":"实现：修 bug","name":"实现","title":"修 bug","profile":"implement","startedAt":1770000005000}`,
		// 无 sub_end：保持 running
	})
	_, env := call(t, ts, http.MethodGet, "/api/sub-sessions?sessionName=main", key, nil)
	list := env["data"].([]any)
	if len(list) != 2 {
		t.Fatalf("list = %v", list)
	}
	first := list[0].(map[string]any) // startedAt 最新的在前
	if first["subSessionId"] != "sub-def456" {
		t.Fatalf("order = %v", first)
	}
	if first["status"] != "running" || first["endedAt"].(float64) != 0 {
		t.Fatalf("running info = %v", first)
	}
	second := list[1].(map[string]any)
	if second["status"] != "completed" || second["endedAt"].(float64) != 1770000009000 {
		t.Fatalf("completed info = %v", second)
	}
	if second["task"] != "探索：检查路由" {
		t.Fatalf("task = %v", second["task"])
	}
	if second["eventCount"].(float64) != 3 {
		t.Fatalf("eventCount = %v", second["eventCount"])
	}
	// 未知父会话：返回空列表
	_, env = call(t, ts, http.MethodGet, "/api/sub-sessions?sessionName=none", key, nil)
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("unknown parent = %d", got)
	}
}

func TestSubSessionEventsAndDelete(t *testing.T) {
	ts, key, home := subSessServer(t)
	writeSubLog(t, home, "main", "sub-abc123", []string{
		`{"type":"sub_start","subSessionId":"sub-abc123","startedAt":1}`,
		`{"type":"sub_content","token":"hi"}`,
	})
	_, env := call(t, ts, http.MethodGet, "/api/sub-sessions/sub-abc123/events?sessionName=main", key, nil)
	events := env["data"].([]any)
	if len(events) != 2 {
		t.Fatalf("events = %v", events)
	}
	// 删除后不可再访问
	_, env = call(t, ts, http.MethodDelete, "/api/sub-sessions/sub-abc123?sessionName=main", key, nil)
	data := env["data"].(map[string]any)
	if data["deleted"] != true {
		t.Fatalf("delete = %v", data)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sub-sessions/sub-abc123/events?sessionName=main", key, nil)
	if env["success"] != false {
		t.Fatalf("after delete = %v", env)
	}
	// 非法 id 被拒绝（路径穿越防护）
	code, _ := call(t, ts, http.MethodGet, "/api/sub-sessions/..%2F..%2Fetc/events?sessionName=main", key, nil)
	if code != http.StatusBadRequest && code != http.StatusNotFound {
		t.Fatalf("traversal = %d", code)
	}
	// 对未知或已过期的子会话发起续聊会被拒绝（不可恢复）
	code, env = call(t, ts, http.MethodPost, "/api/sub-sessions/sub-abc123?sessionName=main", key,
		map[string]string{"message": "hi"})
	if code != http.StatusBadRequest || env["error"] != "子会话不可续聊或已过期" {
		t.Fatalf("chat = %d %v", code, env)
	}
}

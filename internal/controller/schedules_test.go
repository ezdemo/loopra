package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func schedServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "sch0000001", &cfg, agentpkg.Options{
		Model: echo.New("sched-script", echo.Script{Text: "task done"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, home
}

func TestScheduleValidation(t *testing.T) {
	ts, key, _ := schedServer(t)
	cases := []struct {
		name string
		body map[string]any
		err  string
	}{
		{"no message", map[string]any{"intervalSec": 60}, "消息不能为空"},
		{"no session", map[string]any{"message": "hi", "intervalSec": 60}, "sessionName"},
		{"no schedule", map[string]any{"message": "hi", "sessionName": "s1"}, "至少需要一项"},
		{"bad cron", map[string]any{"message": "hi", "sessionName": "s1", "cronExpr": "nope"}, "cron"},
	}
	for _, tc := range cases {
		code, env := call(t, ts, http.MethodPost, "/api/schedules", key, tc.body)
		if code != http.StatusOK || env["success"] != false {
			t.Errorf("%s: status = %d %v", tc.name, code, env)
		}
	}
	// independent 模式无需会话名
	_, env := call(t, ts, http.MethodPost, "/api/schedules", key, map[string]any{
		"message": "standalone job", "sessionMode": "independent", "cronExpr": "0 0 3 * * ?", "enabled": true,
	})
	if env["success"] != true {
		t.Fatalf("independent create = %v", env)
	}
	task := env["data"].(map[string]any)
	if task["nextRunAt"].(float64) <= 0 {
		t.Fatalf("nextRunAt = %v", task["nextRunAt"])
	}
}

func TestScheduleCRUDAndToggle(t *testing.T) {
	ts, key, home := schedServer(t)
	_, env := call(t, ts, http.MethodPost, "/api/schedules", key, map[string]any{
		"message": "daily build", "sessionName": "ci", "cronExpr": "0 0 9 * * ?", "name": "build", "enabled": true,
	})
	task := env["data"].(map[string]any)
	id := task["id"].(string)
	// 持久化到工作区 hash 目录下
	if _, err := os.Stat(filepath.Join(home, "workspace", "sch0000001", "schedules", "schedules.json")); err != nil {
		t.Fatal(err)
	}
	// 更新时保留 runs/runCount
	_, env = call(t, ts, http.MethodPut, "/api/schedules/"+id, key, map[string]any{
		"message": "daily build v2", "sessionName": "ci", "intervalSec": 3600, "enabled": true,
	})
	updated := env["data"].(map[string]any)
	if updated["message"] != "daily build v2" {
		t.Fatalf("updated = %v", updated)
	}
	if updated["createdAt"].(float64) != task["createdAt"].(float64) {
		t.Fatal("createdAt changed on update")
	}
	// toggle 禁用任务并将 nextRunAt 置零
	_, env = call(t, ts, http.MethodPost, "/api/schedules/"+id+"/toggle", key, nil)
	toggled := env["data"].(map[string]any)
	if toggled["enabled"] != false || toggled["nextRunAt"].(float64) != 0 {
		t.Fatalf("toggled = %v", toggled)
	}
	// 删除
	_, env = call(t, ts, http.MethodDelete, "/api/schedules/"+id, key, nil)
	if env["data"] != "已删除" {
		t.Fatalf("delete = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/schedules", key, nil)
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("list after delete = %d", got)
	}
}

func TestScheduleManualRun(t *testing.T) {
	ts, key, _ := schedServer(t)
	_, env := call(t, ts, http.MethodPost, "/api/schedules", key, map[string]any{
		"message": "check status", "sessionName": "ops", "cronExpr": "0 0 9 * * ?",
	})
	id := env["data"].(map[string]any)["id"].(string)
	// 手动运行同步执行并返回回复
	_, env = call(t, ts, http.MethodPost, "/api/schedules/"+id+"/run", key, nil)
	if env["data"] != "task done" {
		t.Fatalf("run reply = %v", env["data"])
	}
	// 任务状态已更新：runCount、lastResult、runs 历史
	_, env = call(t, ts, http.MethodGet, "/api/schedules/"+id, key, nil)
	task := env["data"].(map[string]any)
	if task["runCount"].(float64) != 1 {
		t.Fatalf("runCount = %v", task["runCount"])
	}
	if task["lastResult"] != "task done" {
		t.Fatalf("lastResult = %v", task["lastResult"])
	}
	runs := task["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("runs = %v", runs)
	}
	run := runs[0].(map[string]any)
	if run["status"] != "completed" || run["sessionName"] != "ops" {
		t.Fatalf("run = %v", run)
	}
}

func TestScheduleTickerFiresDueTasks(t *testing.T) {
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "sch0000001", &cfg, agentpkg.Options{
		Model: echo.New("tick-script", echo.Script{Text: "ticked"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	// 使用很短的间隔，使任务立即可到期
	_, env := call(t, ts, http.MethodPost, "/api/schedules", key, map[string]any{
		"message": "fast tick", "sessionName": "ops", "intervalSec": 1, "enabled": true,
	})
	id := env["data"].(map[string]any)["id"].(string)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		srv.scheduleScan()
		_, env = call(t, ts, http.MethodGet, "/api/schedules/"+id, key, nil)
		if env["data"].(map[string]any)["runCount"].(float64) >= 1 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("ticker never executed the due task")
}

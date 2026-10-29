package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func reqServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "req0000001", &cfg, agentpkg.Options{
		Model: echo.New("req-script", echo.Script{Text: "requirement handled"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, home
}

func TestRequirementCRUD(t *testing.T) {
	ts, key, home := reqServer(t)
	// 创建需要 title + projectHash
	code, env := call(t, ts, http.MethodPost, "/api/requirements", key,
		map[string]string{"title": " "})
	if code != http.StatusOK || env["success"] != false {
		t.Fatalf("empty title accepted: %d", code)
	}
	_, env = call(t, ts, http.MethodPost, "/api/requirements", key,
		map[string]string{"title": "支持暗黑模式", "projectHash": "req0000001", "priority": "high"})
	item := env["data"].(map[string]any)
	if item["status"] != "todo" || item["priority"] != "high" {
		t.Fatalf("item = %v", item)
	}
	id := item["id"].(string)
	if item["sessionName"] != "req_"+id {
		t.Fatalf("sessionName = %v", item["sessionName"])
	}
	// 持久化到 ~/.loopra/requirements/requirements.json
	if _, err := os.Stat(filepath.Join(home, "requirements", "requirements.json")); err != nil {
		t.Fatal(err)
	}
	// 更新 description + priority
	_, env = call(t, ts, http.MethodPut, "/api/requirements/"+id, key,
		map[string]string{"description": "夜间主题", "priority": "low"})
	updated := env["data"].(map[string]any)
	if updated["description"] != "夜间主题" || updated["priority"] != "low" {
		t.Fatalf("updated = %v", updated)
	}
	// Java 实体允许自定义优先级标签。
	code, env = call(t, ts, http.MethodPut, "/api/requirements/"+id, key,
		map[string]string{"priority": "urgent"})
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("custom priority rejected")
	}
	// 删除
	_, env = call(t, ts, http.MethodDelete, "/api/requirements/"+id, key, nil)
	if env["data"] != "已删除" {
		t.Fatalf("delete = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/requirements", key, nil)
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("list after delete = %d", got)
	}
}

func TestRequirementRunLifecycle(t *testing.T) {
	ts, key, _ := reqServer(t)
	_, env := call(t, ts, http.MethodPost, "/api/requirements", key,
		map[string]string{"title": "写个 README", "projectHash": "req0000001"})
	id := env["data"].(map[string]any)["id"].(string)

	// 运行后状态转为 doing，并以 echo 回复作为 summary 完成
	if _, env = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/run", key, nil); env["data"] != "已入队执行" {
		t.Fatalf("run = %v", env)
	}
	if _, env = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/run", key, nil); env["success"] != false {
		t.Fatalf("double run accepted: %v", env)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		_, env = call(t, ts, http.MethodGet, "/api/requirements/"+id, key, nil)
		if env["data"].(map[string]any)["status"] == "done" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	item := env["data"].(map[string]any)
	if item["status"] != "done" {
		t.Fatalf("status = %v", item)
	}
	if item["summary"] != "requirement handled" {
		t.Fatalf("summary = %v", item["summary"])
	}
	// 消息中包含已执行的轮次
	_, env = call(t, ts, http.MethodGet, "/api/requirements/"+id+"/messages", key, nil)
	messages := env["data"].([]any)
	if len(messages) < 2 {
		t.Fatalf("messages = %v", messages)
	}
	roles := map[string]bool{}
	for _, m := range messages {
		roles[m.(map[string]any)["role"].(string)] = true
	}
	if !roles["user"] || !roles["assistant"] {
		t.Fatalf("roles = %v", roles)
	}
	// done 状态不能直接再次运行
	_, env = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/run", key, nil)
	if env["success"] != false || env["error"] != "需求正在执行或状态不允许触发: "+id {
		t.Fatalf("run after done = %v", env)
	}
}

func TestRequirementApprovalAndCommentBoundaries(t *testing.T) {
	ts, key, _ := reqServer(t)
	_, env := call(t, ts, http.MethodPost, "/api/requirements", key,
		map[string]string{"title": "X", "projectHash": "req0000001"})
	id := env["data"].(map[string]any)["id"].(string)
	// 新建需求没有待审批操作
	code, env := call(t, ts, http.MethodPost, "/api/requirements/"+id+"/approval", key,
		map[string]string{"action": "approve"})
	if code != http.StatusOK || env["error"] != "需求不存在、未在执行中或没有待审批操作: "+id {
		t.Fatalf("approval without pending: %d %v", code, env)
	}
	// 无效操作
	code, env = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/approval", key,
		map[string]string{"action": "maybe"})
	if code != http.StatusOK || env["success"] != false {
		t.Fatal("invalid action accepted")
	}
	// 空评论被拒绕
	code, env = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/comments", key,
		map[string]string{"text": " "})
	if code != http.StatusOK || env["success"] != false {
		t.Fatal("empty comment accepted")
	}
	// 评论写入会话历史
	_, _ = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/comments", key,
		map[string]string{"text": "请尽快处理"})
	_, env = call(t, ts, http.MethodGet, "/api/requirements/"+id+"/messages", key, nil)
	found := false
	for _, m := range env["data"].([]any) {
		row := m.(map[string]any)
		if row["role"] == "user" && row["content"] == "请尽快处理" {
			found = true
		}
	}
	if !found {
		t.Fatalf("comment not in messages: %v", env["data"])
	}
	// abort 重置 todo 状态的需求（无操作路径）
	_, env = call(t, ts, http.MethodPost, "/api/requirements/"+id+"/abort", key, nil)
	if env["data"] != "已取消" {
		t.Fatalf("abort = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/requirements/"+id, key, nil)
	if env["data"].(map[string]any)["status"] != "todo" {
		t.Fatalf("status after abort = %v", env["data"])
	}
	// 未知 id
	code, env = call(t, ts, http.MethodPost, "/api/requirements/zzz/run", key, nil)
	if code != http.StatusOK || env["success"] != false {
		t.Fatal("unknown id accepted")
	}
}

var _ = genai.RoleUser

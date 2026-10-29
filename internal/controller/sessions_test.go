package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func contextBG() context.Context { return context.Background() }

func getReq(a *agentpkg.Agent, name string) *session.GetRequest {
	return &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: name}
}

func appendTextEvent(t *testing.T, a *agentpkg.Agent, sess session.Session, text string) error {
	t.Helper()
	ev := &session.Event{
		Author: "user", Timestamp: time.Now(),
		Content: &genai.Content{Role: "user", Parts: []*genai.Part{{Text: text}}},
	}
	return a.Sessions.AppendEvent(context.Background(), sess, ev)
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }

// seedSessionMessage 让会话真正落盘：新建会话本身不再创建日志，
// 列表中只应出现写入过消息的会话。
func seedSessionMessage(t *testing.T, s *Controller, hash, name string) {
	t.Helper()
	runtime, err := s.projectRuntime(hash)
	if err != nil {
		t.Fatalf("projectRuntime(%s): %v", hash, err)
	}
	sess, err := runtime.agent.Session(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	event := &session.Event{
		Author: "user", Timestamp: time.Now(),
		Content: genai.NewContentFromText("seed", genai.RoleUser),
	}
	if err := runtime.agent.Sessions.AppendEvent(context.Background(), sess, event); err != nil {
		t.Fatal(err)
	}
}

func sessServer(t *testing.T) (*httptest.Server, string, *agentpkg.Agent) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "ses0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, a
}

func TestSessionTitleAndSettings(t *testing.T) {
	ts, key, a := sessServer(t)
	// 先创建会话，为边车文件提供存放位置
	ctx := contextBG()
	_, _ = a.Sessions.Create(ctx, createReq(a, "work"))
	// 设置标题
	_, env := call(t, ts, http.MethodPut, "/api/sessions/work/title", key,
		map[string]string{"title": "  重构计划  "})
	if env["data"] != "重构计划" {
		t.Fatalf("title = %v", env)
	}
	// 空标题被拒绕
	code, _ := call(t, ts, http.MethodPut, "/api/sessions/work/title", key,
		map[string]string{"title": " "})
	if code != http.StatusBadRequest {
		t.Fatal("empty title accepted")
	}
	// 设置默认来自全局配置
	_, env = call(t, ts, http.MethodGet, "/api/sessions/work/settings", key, nil)
	set := env["data"].(map[string]any)
	if set["model"] != "deepseek-v4-flash" {
		t.Fatalf("settings default = %v", set)
	}
	// 覆盖值持久化到 .meta 边车文件
	_, env = call(t, ts, http.MethodPut, "/api/sessions/work/settings", key,
		map[string]any{"model": "other-model"})
	set = env["data"].(map[string]any)
	if set["model"] != "other-model" {
		t.Fatalf("settings put = %v", set)
	}
	metaPath := filepath.Join(os.TempDir(), "unused")
	_ = metaPath
	_, env = call(t, ts, http.MethodGet, "/api/sessions/work/settings", key, nil)
	if env["data"].(map[string]any)["model"] != "other-model" {
		t.Fatalf("settings readback = %v", env["data"])
	}
}

func TestSessionWorktreeMode(t *testing.T) {
	ts, key, a := sessServer(t)
	_, _ = a.Sessions.Create(contextBG(), createReq(a, "wt"))
	// 默认 manual/off
	_, env := call(t, ts, http.MethodGet, "/api/sessions/wt/worktree", key, nil)
	view := env["data"].(map[string]any)
	if view["worktreeMode"] != false || view["mergeMode"] != "manual" {
		t.Fatalf("worktree default = %v", view)
	}
	// 启用并指定合并模式
	_, env = call(t, ts, http.MethodPut, "/api/sessions/wt/worktree", key,
		map[string]any{"worktreeMode": true, "mergeMode": "ai-auto"})
	view = env["data"].(map[string]any)
	if view["worktreeMode"] != true || view["mergeMode"] != "ai-auto" {
		t.Fatalf("worktree put = %v", view)
	}
	// 无效合并模式被拒绕
	code, _ := call(t, ts, http.MethodPut, "/api/sessions/wt/worktree", key,
		map[string]any{"mergeMode": "auto"})
	if code != http.StatusBadRequest {
		t.Fatal("bad merge mode accepted")
	}
}

func TestNewSessionSortsAboveSavedOrder(t *testing.T) {
	ts, key, a := sessServer(t)
	ctx := contextBG()
	for _, name := range []string{"older", "newer"} {
		created, err := a.Sessions.Create(ctx, createReq(a, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := appendTextEvent(t, a, created.Session, name); err != nil {
			t.Fatal(err)
		}
	}
	if _, env := call(t, ts, http.MethodPut, "/api/sessions/order", key, []string{"older"}); env["data"] != "排序已保存" {
		t.Fatalf("order = %v", env)
	}
	names := sessionNames(t, ts, key)
	if len(names) < 2 || names[0] != "newer" || names[1] != "older" {
		t.Fatalf("new session should lead the saved order, got %v", names)
	}
	// An explicit drag still wins over recency.
	call(t, ts, http.MethodPut, "/api/sessions/order", key, []string{"older", "newer"})
	names = sessionNames(t, ts, key)
	if len(names) < 2 || names[0] != "older" || names[1] != "newer" {
		t.Fatalf("saved drag order lost, got %v", names)
	}
}

func sessionNames(t *testing.T, ts *httptest.Server, key string) []string {
	t.Helper()
	_, env := call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	rows, ok := env["data"].([]any)
	if !ok {
		t.Fatalf("list = %v", env["data"])
	}
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, row.(map[string]any)["name"].(string))
	}
	return names
}

func TestSessionOrderAndCurrentStats(t *testing.T) {
	ts, key, _ := sessServer(t)
	_, env := call(t, ts, http.MethodPut, "/api/sessions/order", key,
		[]string{"b", "a", "c"})
	if env["data"] != "排序已保存" {
		t.Fatalf("order = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions/current", key, nil)
	cur := env["data"].(map[string]any)
	if cur["workspaceHash"] != "ses0000001" {
		t.Fatalf("current = %v", cur)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions/stats", key, nil)
	if env["data"].(map[string]any)["maxCacheSize"].(float64) != 50 {
		t.Fatalf("stats = %v", env["data"])
	}
	_, env = call(t, ts, http.MethodPost, "/api/sessions/evict-all", key, nil)
	if env["data"] != "已清除所有 Agent 缓存" {
		t.Fatalf("evict = %v", env)
	}
}

func TestSessionBranch(t *testing.T) {
	ts, key, a := sessServer(t)
	ctx := contextBG()
	created, _ := a.Sessions.Create(ctx, createReq(a, "source"))
	base := created.Session
	for _, text := range []string{"one", "two", "three"} {
		_ = appendTextEvent(t, a, base, text)
	}
	// 分支前两条事件
	_, env := call(t, ts, http.MethodPost, "/api/sessions/source/branch?messageCount=2", key, nil)
	data := env["data"].(map[string]any)
	if data["message"] != "已分支到新会话" {
		t.Fatalf("branch = %v", data)
	}
	newName := data["sessionName"].(string)
	got, err := a.Sessions.Get(ctx, getReq(a, newName))
	if err != nil {
		t.Fatal(err)
	}
	if got.Session.Events().Len() != 2 {
		t.Fatalf("branched events = %d", got.Session.Events().Len())
	}
	// 无效数量
	code, _ := call(t, ts, http.MethodPost, "/api/sessions/source/branch?messageCount=99", key, nil)
	if code != http.StatusBadRequest {
		t.Fatal("overlong branch accepted")
	}
	// fork 在 Java 中仅支持 ACP
	code, env = call(t, ts, http.MethodPost, "/api/sessions/source/fork", key, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("fork = %d %v", code, env)
	}
}

func TestSessionCleanup(t *testing.T) {
	ts, key, a := sessServer(t)
	ctx := contextBG()
	created, _ := a.Sessions.Create(ctx, createReq(a, "old-session"))
	appendTextEvent(t, a, created.Session, "seed")
	// 清理 now+1s 之前的所有会话
	before := time.Now().Add(time.Second).UnixMilli()
	_, env := call(t, ts, http.MethodDelete,
		"/api/sessions/cleanup?before="+itoa(before), key, nil)
	data := env["data"].(map[string]any)
	removed := data["sessionNames"].([]any)
	if len(removed) == 0 {
		t.Fatalf("cleanup = %v", data)
	}
	if _, err := a.Sessions.Get(ctx, getReq(a, "old-session")); err == nil {
		t.Fatal("session survived cleanup")
	}
	// 缺少 before 被拒绕
	code, _ := call(t, ts, http.MethodDelete, "/api/sessions/cleanup", key, nil)
	if code != http.StatusBadRequest {
		t.Fatal("cleanup without before accepted")
	}
}

func TestSessionChecklistGoalNull(t *testing.T) {
	ts, key, a := sessServer(t)
	_, _ = a.Sessions.Create(contextBG(), createReq(a, "plain"))
	for _, path := range []string{"/api/sessions/plain/checklist", "/api/sessions/plain/goal"} {
		_, env := call(t, ts, http.MethodGet, path, key, nil)
		if env["data"] != nil {
			t.Fatalf("%s = %v", path, env["data"])
		}
	}
	_ = json.Marshal
}

// 新建会话是惰性的：未发送消息时不落盘、不出现在列表里，
// 写入首条消息后才创建日志并可见。
func TestNewSessionStaysOffDiskUntilFirstMessage(t *testing.T) {
	ts, key, a := sessServer(t)
	dir := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions")
	_, env := call(t, ts, http.MethodPost, "/api/sessions/new?sessionName=pending", key, nil)
	if env["success"] != true || env["data"].(map[string]any)["sessionName"] != "pending" {
		t.Fatalf("new = %v", env)
	}
	if _, err := os.Stat(filepath.Join(dir, "pending.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("new session created a log before its first message: %v", err)
	}
	// 会话设置快照（.meta）可以提前固定，但它不是会话本身。
	if _, err := os.Stat(filepath.Join(dir, "pending.meta")); err != nil {
		t.Fatalf("session settings snapshot missing: %v", err)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if rows := env["data"].([]any); len(rows) != 0 {
		t.Fatalf("pending session leaked into the list: %v", rows)
	}
	// 首条消息写入后才落盘并出现在列表中。
	sess, err := a.Session(contextBG(), "pending")
	if err != nil {
		t.Fatal(err)
	}
	if err := appendTextEvent(t, a, sess, "第一条消息"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "pending.jsonl")); err != nil {
		t.Fatalf("first message did not create the session log: %v", err)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	rows := env["data"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["name"] != "pending" || rows[0].(map[string]any)["messageCount"].(float64) != 1 {
		t.Fatalf("list after first message = %v", rows)
	}
	// 对已存在的会话再次调用 new 只切换，不报错（Java 语义）。
	if _, env = call(t, ts, http.MethodPost, "/api/sessions/new?sessionName=pending", key, nil); env["success"] != true {
		t.Fatalf("new on existing session = %v", env)
	}
}

// 打开聊天视图时前端会调用 agent-engines/prepare；它同样不得物化会话。
func TestEnginePrepareDoesNotMaterializeSession(t *testing.T) {
	ts, key, a := sessServer(t)
	_, env := call(t, ts, http.MethodPost, "/api/agent-engines/prepare", key,
		map[string]any{"sessionName": "prepared"})
	if env["success"] != true {
		t.Fatalf("prepare = %v", env)
	}
	dir := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions")
	if _, err := os.Stat(filepath.Join(dir, "prepared.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("prepare created a session log: %v", err)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if rows := env["data"].([]any); len(rows) != 0 {
		t.Fatalf("prepared session leaked into the list: %v", rows)
	}
}

// 旧版本留下的 0 字节会话日志不再出现在列表中；
// 只有 .meta 的计划模式会话仍然可见（Java list() 的例外规则）。
func TestEmptyLogsHiddenButMetadataOnlyPlanSessionsVisible(t *testing.T) {
	ts, key, a := sessServer(t)
	dir := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "legacy-empty.jsonl"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, env := call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if rows := env["data"].([]any); len(rows) != 0 {
		t.Fatalf("empty session log was listed: %v", rows)
	}
	// 计划模式可能在首条消息前开启，此时只有 .meta。
	call(t, ts, http.MethodPost, "/api/agent/mode", key, map[string]any{"sessionName": "planning", "enabled": true})
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	rows := env["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("plan-only session missing from list: %v", rows)
	}
	row := rows[0].(map[string]any)
	if row["name"] != "planning" || row["messageCount"].(float64) != 0 {
		t.Fatalf("plan-only row = %v", row)
	}
	// 关闭计划模式后重新隐藏。
	call(t, ts, http.MethodPost, "/api/agent/mode", key, map[string]any{"sessionName": "planning", "enabled": false})
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if rows := env["data"].([]any); len(rows) != 0 {
		t.Fatalf("plan session still listed after disabling plan mode: %v", rows)
	}
}

// 回滚可能把可见日志截断为空，但 .events 审计镜像仍在：
// 这类会话仍应保留在列表中（与 Java 按文件存在列出会话一致）。
func TestRolledBackSessionRemainsListed(t *testing.T) {
	ts, key, a := sessServer(t)
	ctx := contextBG()
	created, err := a.Sessions.Create(ctx, createReq(a, "rollback"))
	if err != nil {
		t.Fatal(err)
	}
	if err := appendTextEvent(t, a, created.Session, "唯一一条消息"); err != nil {
		t.Fatal(err)
	}
	// 模拟回滚到第一条消息：可见日志被清空，审计镜像保持不变。
	path := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions", "rollback.jsonl")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, env := call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	rows := env["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rolled-back session disappeared from the list: %v", rows)
	}
	row := rows[0].(map[string]any)
	if row["name"] != "rollback" || row["messageCount"].(float64) != 0 {
		t.Fatalf("rolled-back row = %v", row)
	}
}

// 清理过期会话时也要清掉“只有 .meta 的计划会话”和旧版 0 字节空白日志：
// 前者在列表中可见，但存储层 List 不返回它。
func TestCleanupRemovesMetadataOnlyPlanSessions(t *testing.T) {
	ts, key, a := sessServer(t)
	dir := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 只有 .meta、未发消息的计划模式会话（列表里可见）。
	call(t, ts, http.MethodPost, "/api/sessions/new?sessionName=planning", key, nil)
	call(t, ts, http.MethodPost, "/api/agent/mode", key, map[string]any{"sessionName": "planning", "enabled": true})
	// 旧版本遗留的 0 字节空白日志（列表里不可见，但仍在磁盘上）。
	legacy := filepath.Join(dir, "legacy.jsonl")
	if err := os.WriteFile(legacy, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, env := call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if rows := env["data"].([]any); len(rows) != 1 {
		t.Fatalf("precondition list = %v", rows)
	}
	before := time.Now().Add(time.Second).UnixMilli()
	_, env = call(t, ts, http.MethodDelete, "/api/sessions/cleanup?before="+itoa(before), key, nil)
	names := env["data"].(map[string]any)["sessionNames"].([]any)
	if len(names) != 2 {
		t.Fatalf("cleanup removed = %v", names)
	}
	if _, err := os.Stat(filepath.Join(dir, "planning.meta")); !os.IsNotExist(err) {
		t.Fatalf("plan-only metadata survived cleanup: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy empty log survived cleanup: %v", err)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if rows := env["data"].([]any); len(rows) != 0 {
		t.Fatalf("list after cleanup = %v", rows)
	}
}

// 切换会话是惰性的：允许指向尚未落盘的新会话。
func TestSwitchToPendingSessionIsLazy(t *testing.T) {
	ts, key, a := sessServer(t)
	call(t, ts, http.MethodPost, "/api/sessions/new?sessionName=fresh", key, nil)
	_, env := call(t, ts, http.MethodPost, "/api/sessions/later", key, nil)
	if env["success"] != true {
		t.Fatalf("switch to a pending session = %v", env)
	}
	data := env["data"].(map[string]any)
	if data["sessionName"] != "later" || data["switched"] != true {
		t.Fatalf("switch payload = %v", data)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions/current", key, nil)
	if env["data"].(map[string]any)["sessionName"] != "later" {
		t.Fatalf("current = %v", env["data"])
	}
	path := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions", "later.jsonl")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("switching persisted an empty session: %v", err)
	}
}

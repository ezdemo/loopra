package controller

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

// newGitServer 构建一个工作区初始即为 git 仓库的服务端。
func newGitServer(t *testing.T) (*httptest.Server, string, string, string) {
	t.Helper()
	if !gitops.Available() {
		t.Skip("git binary not available")
	}
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	run := gitops.Runner{Dir: ws}
	run.Git(gitops.TimeoutQuery, "init", "-q")
	run.Git(gitops.TimeoutQuery, "config", "user.email", "test@loopra")
	run.Git(gitops.TimeoutQuery, "config", "user.name", "Test")
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "git0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, ts.URL + "/", ws
}

// call 发出一次带密钥认证的请求并解码响应外壳。
func call(t *testing.T, ts *httptest.Server, method, path, key string, body any) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req, err := http.NewRequest(method, ts.URL+path, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var envelope map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return resp.StatusCode, envelope
}

// newPlainServer 构建一个工作区尚未初始化 Git 的服务端。
func newPlainServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "noGit1234", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, ws
}

// GET /api/git/init 的 initialCommit 来自查询参数（前端即如此调用）。
func TestGitInitHonorsInitialCommitQuery(t *testing.T) {
	if !gitops.Available() {
		t.Skip("git binary not available")
	}
	ts, key, _ := newPlainServer(t)
	code, env := call(t, ts, http.MethodPost, "api/git/init?initialCommit=true", key, nil)
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("init: %d %v", code, env)
	}
	_, env = call(t, ts, http.MethodGet, "api/git/log", key, nil)
	commits := env["data"].(map[string]any)["commits"].([]any)
	if len(commits) != 1 || commits[0].(map[string]any)["message"] != "Initial commit" {
		t.Fatalf("commits = %v", commits)
	}
}

// 空仓库的提交历史必须是空数组而不是 null（前端直接 .map）。
func TestGitLogReturnsEmptyArray(t *testing.T) {
	ts, key, _, _ := newGitServer(t)
	_, env := call(t, ts, http.MethodGet, "api/git/log", key, nil)
	commits, ok := env["data"].(map[string]any)["commits"].([]any)
	if !ok || len(commits) != 0 {
		t.Fatalf("commits = %#v", env["data"].(map[string]any)["commits"])
	}
}

// 会话环境未创建隔离分支时仍报告 worktree 模式，currentPath 为空。
func TestGitEnvironmentModeBeforeWorktreeCreated(t *testing.T) {
	ts, key, _, _ := newGitServer(t)
	call(t, ts, http.MethodPut, "api/sessions/env1/worktree?workspaceHash=git0000001", key,
		map[string]any{"worktreeMode": true})
	_, env := call(t, ts, http.MethodGet, "api/git/environment?sessionName=env1", key, nil)
	data := env["data"].(map[string]any)
	if data["mode"] != "worktree" || data["currentPath"] != "" || data["worktreeExists"] != false {
		t.Fatalf("environment = %v", data)
	}
	_, env = call(t, ts, http.MethodGet, "api/git/environment/status?sessionName=env1", key, nil)
	status := env["data"].(map[string]any)
	if status["current"] != nil {
		t.Fatalf("current status should be null: %v", status)
	}
	if status["main"] == nil {
		t.Fatalf("main status missing: %v", status)
	}
}

// environment/commit 未指定文件时应 add -A 提交全部改动。
func TestGitEnvironmentCommitAddsAllChanges(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	os.WriteFile(filepath.Join(ws, "seed.txt"), []byte("1\n"), 0o644)
	run := gitops.Runner{Dir: ws}
	run.Git(gitops.TimeoutQuery, "add", "-A")
	run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "seed")
	os.WriteFile(filepath.Join(ws, "fresh.txt"), []byte("2\n"), 0o644)
	code, env := call(t, ts, http.MethodPost, "api/git/environment/commit?sessionName=env2", key,
		map[string]any{"message": "env all"})
	if code != http.StatusOK {
		t.Fatalf("environment commit: %d %v", code, env)
	}
	_, env = call(t, ts, http.MethodGet, "api/git/status", key, nil)
	dto := env["data"].(map[string]any)
	if got := dto["untracked"].([]any); len(got) != 0 {
		t.Fatalf("untracked after add -A = %v", got)
	}
	_, env = call(t, ts, http.MethodGet, "api/git/log", key, nil)
	commits := env["data"].(map[string]any)["commits"].([]any)
	if len(commits) == 0 || commits[0].(map[string]any)["message"] != "env all" {
		t.Fatalf("commits = %v", commits)
	}
}

func TestGitBranchDiffStatusLog(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	os.WriteFile(filepath.Join(ws, "seed.txt"), []byte("1\n"), 0o644)
	run := gitops.Runner{Dir: ws}
	run.Git(gitops.TimeoutQuery, "add", "-A")
	run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "seed")

	// 分支
	code, env := call(t, ts, http.MethodGet, "api/git/branch", key, nil)
	if code != http.StatusOK {
		t.Fatalf("branch: %d %v", code, env)
	}
	if _, ok := env["data"].(map[string]any)["branch"].(string); !ok {
		t.Fatalf("branch data = %v", env["data"])
	}

	// 含未跟踪文件的状态
	os.WriteFile(filepath.Join(ws, "new.txt"), []byte("x\n"), 0o644)
	_, env = call(t, ts, http.MethodGet, "api/git/status", key, nil)
	dto := env["data"].(map[string]any)
	if dto["initialized"] != true || dto["gitAvailable"] != true {
		t.Fatalf("status dto = %v", dto)
	}
	untracked := dto["untracked"].([]any)
	if len(untracked) != 1 {
		t.Fatalf("untracked = %v", untracked)
	}
	// 未跟踪项必须是 GitFileChangeDTO 形状（Java 契约），而不是裸字符串。
	entry := untracked[0].(map[string]any)
	if entry["path"] != "new.txt" || entry["index"] != "?" || entry["workTree"] != "?" || entry["status"] != "U" {
		t.Fatalf("untracked[0] = %v", entry)
	}
	if _, ok := dto["workspacePath"].(string); !ok {
		t.Fatalf("workspacePath missing: %v", dto)
	}

	// 差异聚合
	_, env = call(t, ts, http.MethodGet, "api/git/diff", key, nil)
	dd := env["data"].(map[string]any)
	if dd["count"].(float64) != 1 {
		t.Fatalf("diff count = %v", dd["count"])
	}

	// 日志
	_, env = call(t, ts, http.MethodGet, "api/git/log?limit=10", key, nil)
	ld := env["data"].(map[string]any)
	commits := ld["commits"].([]any)
	if len(commits) != 1 || commits[0].(map[string]any)["message"] != "seed" {
		t.Fatalf("log = %v", commits)
	}
}

func TestGitStatusNotARepo(t *testing.T) {
	if !gitops.Available() {
		t.Skip("git binary not available")
	}
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, _ := agentpkg.New(home, "noGit1234", &cfg, agentpkg.Options{})
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	_, env := call(t, ts, http.MethodGet, "api/git/status", key, nil)
	dto := env["data"].(map[string]any)
	if dto["initialized"] != false {
		t.Fatalf("dto = %v", dto)
	}
	code, env := call(t, ts, http.MethodGet, "api/git/branch", key, nil)
	if code != http.StatusBadRequest || env["success"] != false {
		t.Fatalf("branch on non-repo: %d %v", code, env)
	}
}

func TestGitConfigGetPostValidation(t *testing.T) {
	ts, key, _, _ := newGitServer(t)
	// GET 回退到 git config 中的身份信息
	_, env := call(t, ts, http.MethodGet, "api/git/config", key, nil)
	cfg := env["data"].(map[string]any)
	if cfg["authorName"] != "Test" || cfg["authorEmail"] != "test@loopra" {
		t.Fatalf("config = %v", cfg)
	}
	// 缺少名称的 POST 请求会失败
	code, env := call(t, ts, http.MethodPost, "api/git/config", key,
		map[string]string{"authorEmail": "x@y"})
	if code != http.StatusBadRequest || env["success"] != false {
		t.Fatalf("config validation: %d %v", code, env)
	}
	// POST 持久化并回显
	_, env = call(t, ts, http.MethodPost, "api/git/config", key,
		map[string]string{"authorName": "Loopra", "authorEmail": "l@l", "model": "m1"})
	cfg = env["data"].(map[string]any)
	if cfg["authorName"] != "Loopra" || cfg["model"] != "m1" {
		t.Fatalf("config after post = %v", cfg)
	}
}

func TestGitCommitFlowAndValidation(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	os.WriteFile(filepath.Join(ws, "a.txt"), []byte("1\n"), 0o644)
	os.WriteFile(filepath.Join(ws, "b.txt"), []byte("2\n"), 0o644)

	// 空消息
	code, env := call(t, ts, http.MethodPost, "api/git/commit", key,
		map[string]string{"message": " "})
	if code != http.StatusBadRequest || env["error"] != "Commit message is required" {
		t.Fatalf("empty message: %d %v", code, env)
	}

	// 只提交单个文件
	_, env = call(t, ts, http.MethodPost, "api/git/commit", key,
		map[string]any{"message": "only a", "files": []string{"a.txt"}})
	if env["success"] != true {
		t.Fatalf("commit: %v", env)
	}
	if _, err := os.Stat(filepath.Join(ws, "a.txt")); err != nil {
		t.Fatal(err)
	}
	// b.txt 必须仍为未跟踪状态，不被提交
	_, env = call(t, ts, http.MethodGet, "api/git/status", key, nil)
	dto := env["data"].(map[string]any)
	if got := dto["untracked"].([]any); len(got) != 1 || got[0].(map[string]any)["path"] != "b.txt" {
		t.Fatalf("b.txt state = %v", got)
	}

	// 没有暂存内容时提交 -> git 错误以 400 返回
	os.WriteFile(filepath.Join(ws, "a.txt"), []byte("1\n"), 0o644)
	code, env = call(t, ts, http.MethodPost, "api/git/commit", key,
		map[string]string{"message": "nothing new"})
	if code != http.StatusBadRequest || !strings.Contains(env["error"].(string), "git commit failed") {
		t.Fatalf("no-change commit: %d %v", code, env)
	}
}

func TestGitInitToggleAndContent(t *testing.T) {
	if !gitops.Available() {
		t.Skip("git binary not available")
	}
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, _ := agentpkg.New(home, "noGit1234", &cfg, agentpkg.Options{})
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	// init 创建仓库与 .gitignore
	_, env := call(t, ts, http.MethodPost, "api/git/init", key,
		map[string]bool{"initialCommit": true})
	data := env["data"].(map[string]any)
	if data["initialized"] != true {
		t.Fatalf("init = %v", data)
	}
	if _, err := os.Stat(filepath.Join(ws, ".gitignore")); err != nil {
		t.Fatal("gitignore missing")
	}
	// 第二次 init 被拒绝
	code, env := call(t, ts, http.MethodPost, "api/git/init", key, nil)
	if code != http.StatusBadRequest || env["error"] != "Already a git repository" {
		t.Fatalf("re-init: %d %v", code, env)
	}

	// toggle 暂存一个未跟踪文件
	os.WriteFile(filepath.Join(ws, "x.txt"), []byte("x\n"), 0o644)
	_, env = call(t, ts, http.MethodPost, "api/git/toggle", key,
		map[string]any{"path": "x.txt"})
	data = env["data"].(map[string]any)
	if data["newState"] != "changed" {
		t.Fatalf("toggle stage = %v", data)
	}
	// 再次 toggle 取消暂存
	_, env = call(t, ts, http.MethodPost, "api/git/toggle", key,
		map[string]any{"path": "x.txt", "staged": false})
	data = env["data"].(map[string]any)
	if data["newState"] != "untracked" {
		t.Fatalf("toggle unstage = %v", data)
	}
	// staged 必须为布尔值
	code, env = call(t, ts, http.MethodPost, "api/git/toggle", key,
		map[string]any{"path": "x.txt", "staged": "yes"})
	if code != http.StatusBadRequest || env["error"] != "staged 必须为布尔值" {
		t.Fatalf("staged type: %d %v", code, env)
	}

	// file-content / working-file-content / diff-content
	os.WriteFile(filepath.Join(ws, "x.txt"), []byte("hello\n"), 0o644)
	run := gitops.Runner{Dir: ws}
	// CI 没有全局 git 身份，裸 commit 会失败，随后 file-content 返回 400。
	run.Git(gitops.TimeoutQuery, "config", "user.email", "test@loopra")
	run.Git(gitops.TimeoutQuery, "config", "user.name", "Test")
	if _, stderr, err := run.Git(gitops.TimeoutQuery, "add", "-A"); err != nil {
		t.Fatal(stderr)
	}
	if _, stderr, err := run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "x"); err != nil {
		t.Fatal(stderr)
	}
	code, env = call(t, ts, http.MethodGet, "api/git/file-content?path=x.txt", key, nil)
	if code != http.StatusOK {
		t.Fatalf("file-content: %d %v", code, env)
	}
	if env["data"].(map[string]any)["content"] != "hello\n" {
		t.Fatalf("file-content = %v", env["data"])
	}
	_, env = call(t, ts, http.MethodGet, "api/git/working-file-content?path=x.txt:12", key, nil)
	fc := env["data"].(map[string]any)
	if fc["content"] != "hello\n" || fc["exists"] != true {
		t.Fatalf("working-file-content = %v", fc)
	}
	os.WriteFile(filepath.Join(ws, "gone.txt"), []byte("z\n"), 0o644)
	_, env = call(t, ts, http.MethodGet, "api/git/diff-content?path=gone.txt", key, nil)
	dc := env["data"].(map[string]any)
	if !strings.Contains(dc["diff"].(string), "+++ b/gone.txt") {
		t.Fatalf("synthesized untracked diff = %v", dc["diff"])
	}
}

func TestGitWorktreeCreateAndEnvironment(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	os.WriteFile(filepath.Join(ws, "seed.txt"), []byte("1\n"), 0o644)
	run := gitops.Runner{Dir: ws}
	run.Git(gitops.TimeoutQuery, "add", "-A")
	run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "seed")

	// 先行校验
	code, env := call(t, ts, http.MethodPost, "api/git/worktree/create", key,
		map[string]string{"workspaceHash": "git0000001"})
	if code != http.StatusBadRequest || env["error"] != "workspaceHash 与 sessionName 必填" {
		t.Fatalf("worktree validation: %d %v", code, env)
	}
	// 创建后再次创建（幂等）
	for i := 0; i < 2; i++ {
		_, env = call(t, ts, http.MethodPost, "api/git/worktree/create", key,
			map[string]string{"workspaceHash": "git0000001", "sessionName": "sess one"})
		data := env["data"].(map[string]any)
		if data["exists"] != true {
			t.Fatalf("worktree create #%d = %v", i, data)
		}
		if _, ok := data["branch"].(string); !ok || !strings.HasPrefix(data["branch"].(string), "loopra/sandbox-") {
			t.Fatalf("branch = %v", data["branch"])
		}
	}
	// 环境切换为 worktree 模式
	_, env = call(t, ts, http.MethodGet, "api/git/environment?sessionName=sess%20one", key, nil)
	if env["data"] == nil {
		t.Fatalf("environment response = %v", env)
	}
	ed := env["data"].(map[string]any)
	if ed["mode"] != "worktree" || ed["worktreeExists"] != true {
		t.Fatalf("environment = %v", ed)
	}
	// environment log 需要合法的 scope
	code, env = call(t, ts, http.MethodGet, "api/git/environment/log?scope=bogus", key, nil)
	if code != http.StatusBadRequest || env["error"] != "scope 只能是 main 或 current" {
		t.Fatalf("scope validation: %d %v", code, env)
	}
	_, env = call(t, ts, http.MethodGet, "api/git/environment/status?sessionName=sess%20one", key, nil)
	sd := env["data"].(map[string]any)
	if sd["mode"] != "worktree" {
		t.Fatalf("environment status = %v", sd)
	}
}

func TestSnapshotCheckpointRollbackDelete(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	os.WriteFile(filepath.Join(ws, "a.txt"), []byte("v1\n"), 0o644)
	run := gitops.Runner{Dir: ws}
	run.Git(gitops.TimeoutQuery, "add", "-A")
	run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "base")

	// 不带 msgId 的 checkpoint：HTTP 200、success=false（与 Java 对齐）
	code, env := call(t, ts, http.MethodPost, "api/snapshots/checkpoint", key, nil)
	if code != http.StatusOK || env["success"] != false {
		t.Fatalf("checkpoint validation: %d %v", code, env)
	}

	// 创建检查点
	_, env = call(t, ts, http.MethodPost, "api/snapshots/checkpoint?msgId=m1", key, nil)
	snap := env["data"].(map[string]any)
	if snap["commitHash"] == "" || snap["treeHash"] == "" {
		t.Fatalf("checkpoint = %v", snap)
	}
	if _, ok := snap["createdAt"].(float64); !ok {
		t.Fatalf("createdAt missing: %v", snap)
	}
	// 列表展示该快照
	_, env = call(t, ts, http.MethodGet, "api/snapshots", key, nil)
	list := env["data"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["msgId"] != "m1" {
		t.Fatalf("list = %v", list)
	}
	// 状态
	_, env = call(t, ts, http.MethodGet, "api/snapshots/status", key, nil)
	if env["data"].(map[string]any)["gitRepo"] != true {
		t.Fatalf("status = %v", env["data"])
	}

	// 修改内容后回滚
	os.WriteFile(filepath.Join(ws, "a.txt"), []byte("v2-changed\n"), 0o644)
	_, env = call(t, ts, http.MethodPost, "api/snapshots/rollback", key,
		map[string]any{"msgId": "m1"})
	rb := env["data"].(map[string]any)
	if rb["success"] != true || rb["msgId"] != "m1" {
		t.Fatalf("rollback = %v", rb)
	}
	data, _ := os.ReadFile(filepath.Join(ws, "a.txt"))
	if got := strings.TrimRight(string(data), "\r\n"); got != "v1" {
		t.Fatalf("a.txt after rollback = %q", data)
	}
	// 回滚后该 ref 已不存在
	_, env = call(t, ts, http.MethodPost, "api/snapshots/rollback", key,
		map[string]any{"msgId": "m1"})
	if env["success"] != false || !strings.Contains(env["error"].(string), "未找到消息") {
		t.Fatalf("rollback twice: %v", env)
	}

	// 删除流程
	_, env = call(t, ts, http.MethodPost, "api/snapshots/checkpoint?msgId=m2", key, nil)
	if env["success"] != true {
		t.Fatalf("checkpoint m2: %v", env)
	}
	_, env = call(t, ts, http.MethodDelete, "api/snapshots/m2", key, nil)
	if env["data"] != "快照已删除" {
		t.Fatalf("delete = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "api/snapshots", key, nil)
	if env["data"] == nil {
		t.Fatalf("list after delete = %v", env)
	}
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("list after delete = %d", got)
	}
}

func TestGenerateCommitMessage(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		if !strings.Contains(fmt.Sprint(request["messages"]), "feat.txt") {
			t.Error("commit prompt omitted the changed file")
		}
		writeJSON(w, 200, map[string]any{"id": "commit", "choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": "feat: add feat.txt"}, "finish_reason": "stop"}}})
	}))
	defer upstream.Close()
	call(t, ts, http.MethodPut, "api/config", key, map[string]any{"apiKey": "test-key", "baseUrl": upstream.URL + "/v1"})
	os.WriteFile(filepath.Join(ws, "feat.txt"), []byte("x\n"), 0o644)
	_, env := call(t, ts, http.MethodPost, "api/git/generate-commit-message", key, nil)
	if env["success"] != true {
		t.Fatalf("generate = %v", env)
	}
	msg := env["data"].(map[string]any)["message"].(string)
	if !strings.Contains(msg, "feat.txt") {
		t.Fatalf("message = %q", msg)
	}
	// 仓库干净 -> 无变更
	run := gitops.Runner{Dir: ws}
	run.Git(gitops.TimeoutQuery, "add", "-A")
	run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "c1")
	code, env := call(t, ts, http.MethodPost, "api/git/generate-commit-message", key, nil)
	if code != http.StatusBadRequest || env["error"] != "没有待提交的变更" {
		t.Fatalf("clean generate: %d %v", code, env)
	}
}

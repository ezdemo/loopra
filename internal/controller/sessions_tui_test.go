package controller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

// fakeTuiCLI 用登录 shell 冒充外部 Agent CLI：进程能拉起且常驻，
// key 复用与删除关闭的行为因此可断言。
func fakeTuiCLI(t *testing.T) {
	t.Helper()
	name := "sh"
	if runtime.GOOS == "windows" {
		name = "cmd.exe"
	}
	shell, err := exec.LookPath(name)
	if err != nil {
		t.Skip("no shell to impersonate devin CLI")
	}
	t.Setenv("LOOPRA_DEVIN_EXECUTABLE", shell)
}

// tuiServer 与 sessServer 同构，但把 Controller 留给调用方，
// 测试可以直接等待 Hub 里 PTY 的退出。
func tuiServer(t *testing.T) (*httptest.Server, string, *Controller) {
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
	return ts, key, srv
}

// closeHubTerminals 关掉 Hub 里所有终端并等进程退出。
func closeHubTerminals(srv *Controller, timeout time.Duration) {
	hub := srv.shellHub()
	for _, info := range hub.List() {
		if term, ok := hub.Get(info.ID); ok {
			term.Close()
			select {
			case <-term.ProcessDone():
			case <-time.After(timeout):
			}
		}
	}
}

func sessionRowByName(t *testing.T, env map[string]any, name string) map[string]any {
	t.Helper()
	rows, ok := env["data"].([]any)
	if !ok {
		t.Fatalf("sessions list = %v", env)
	}
	for _, raw := range rows {
		row := raw.(map[string]any)
		if row["name"] == name {
			return row
		}
	}
	return nil
}

// waitPtyExit 等 PTY 进程真正退出：Windows 上删掉会话后 cmd.exe
// 的工作目录句柄要等进程退出才释放，TempDir 清理不能抢在前面。
// 删除会把会话移出 Hub，所以调用方要先拿到 Session 再删。
func waitPtyExit(t *testing.T, srv *Controller, id string, delete func()) {
	t.Helper()
	term, ok := srv.shellHub().Get(id)
	delete()
	if !ok {
		return
	}
	select {
	case <-term.ProcessDone():
	case <-time.After(15 * time.Second):
		t.Fatal("pty session did not exit")
	}
}

func TestTuiSessionCreateAndList(t *testing.T) {
	ts, key, srv := tuiServer(t)
	fakeTuiCLI(t)
	code, env := call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
		map[string]string{"agentId": "devin"})
	if code != http.StatusOK {
		t.Fatalf("create = %d %v", code, env)
	}
	info := env["data"].(map[string]any)
	name, _ := info["sessionName"].(string)
	if name == "" || info["agent"] != "devin" {
		t.Fatalf("tui open info = %v", info)
	}
	// 元数据落盘：TUI 会话出现在会话列表并标记 mode。
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	row := sessionRowByName(t, env, name)
	if row == nil {
		t.Fatalf("tui session %q missing from list: %v", name, env["data"])
	}
	if row["mode"] != "tui" || row["agentId"] != "devin" {
		t.Fatalf("tui row = %v", row)
	}
	// 重开同会话复用活着的 PTY。
	code, env = call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
		map[string]string{"agentId": "devin", "sessionName": name})
	if code != http.StatusOK || env["data"].(map[string]any)["id"] != info["id"] {
		t.Fatalf("reopen = %d %v", code, env)
	}
	// 绑定了 devin 的 TUI 会话不能用另一个 Agent 打开。
	code, _ = call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
		map[string]string{"agentId": "codex", "sessionName": name})
	if code != http.StatusBadRequest {
		t.Fatalf("agent mismatch = %d", code)
	}
	// 删除关闭 PTY 并从列表消失。
	var delCode int
	waitPtyExit(t, srv, info["id"].(string), func() {
		delCode, _ = call(t, ts, http.MethodDelete, "/api/sessions/"+name, key, nil)
	})
	if delCode != http.StatusOK {
		t.Fatalf("delete = %d", delCode)
	}
	_, env = call(t, ts, http.MethodGet, "/api/sessions", key, nil)
	if row := sessionRowByName(t, env, name); row != nil {
		t.Fatalf("deleted session still listed: %v", row)
	}
	_, env = call(t, ts, http.MethodGet, "/api/shell-terminal/sessions", key, nil)
	for _, raw := range env["data"].(map[string]any)["sessions"].([]any) {
		if raw.(map[string]any)["id"] == info["id"] {
			t.Fatalf("deleted session PTY still open: %v", raw)
		}
	}
}

func TestTuiSessionGuiRejected(t *testing.T) {
	ts, key, srv := tuiServer(t)
	fakeTuiCLI(t)
	if _, err := srv.agent.Sessions.Create(context.Background(), createReq(srv.agent, "work")); err != nil {
		t.Fatal(err)
	}
	code, _ := call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
		map[string]string{"agentId": "devin", "sessionName": "work"})
	if code != http.StatusBadRequest {
		t.Fatalf("gui session open = %d", code)
	}
}

func TestTuiSessionGuards(t *testing.T) {
	ts, key, srv := tuiServer(t)
	fakeTuiCLI(t)
	code, env := call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
		map[string]string{"agentId": "devin"})
	if code != http.StatusOK {
		t.Fatalf("create = %d %v", code, env)
	}
	info := env["data"].(map[string]any)
	t.Cleanup(func() { closeHubTerminals(srv, 15*time.Second) })
	name := info["sessionName"].(string)
	// TUI 会话不进入对话/ACP 流程。
	code, _ = call(t, ts, http.MethodPost, "/api/chat/stream", key,
		map[string]string{"message": "hi", "sessionName": name})
	if code != http.StatusBadRequest {
		t.Fatalf("chat on tui session = %d", code)
	}
	code, _ = call(t, ts, http.MethodPost, "/api/agent-engines/prepare", key,
		map[string]string{"sessionName": name, "agentId": "devin"})
	if code != http.StatusBadRequest {
		t.Fatalf("prepare on tui session = %d", code)
	}
	code, _ = call(t, ts, http.MethodPost, "/api/sessions/"+name+"/fork", key, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("fork on tui session = %d", code)
	}
}

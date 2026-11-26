package controller

import (
	"net/http"
	"testing"
	"time"
)

func TestShellTerminalAgentValidation(t *testing.T) {
	ts, key, srv := tuiServer(t)
	t.Cleanup(func() { closeHubTerminals(srv, 15*time.Second) })
	// 空 body 保持普通登录 shell。
	code, env := call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key, nil)
	if code != http.StatusOK {
		t.Fatalf("plain open = %d %v", code, env)
	}
	info := env["data"].(map[string]any)
	if info["id"] == "" || info["agent"] != nil {
		t.Fatalf("plain shell info = %v", info)
	}
	// native、未知 Agent 和仅走 ACP 的 SolonCode 一律 400。
	for _, agent := range []string{"native", "no-such-agent", "soloncode"} {
		code, env = call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
			map[string]string{"agentId": agent})
		if code != http.StatusBadRequest {
			t.Fatalf("agent %q open = %d %v", agent, code, env)
		}
	}
}

func TestShellTerminalAgentSession(t *testing.T) {
	ts, key, srv := tuiServer(t)
	// 用登录 shell 冒充 devin CLI：命令能被拉起且不会立刻退出，
	// 同 key 的第二次打开因此稳定复用同一会话。
	fakeTuiCLI(t)
	// 收尾关掉拉起的 shell 并等进程退出，Windows 上 TempDir 才能删掉工作目录。
	t.Cleanup(func() { closeHubTerminals(srv, 15*time.Second) })
	body := map[string]string{"agentId": "devin", "sessionName": "tui-one"}
	code, env := call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key, body)
	if code != http.StatusOK {
		t.Fatalf("agent open = %d %v", code, env)
	}
	info := env["data"].(map[string]any)
	if info["agent"] != "devin" || info["title"] != "Devin" {
		t.Fatalf("agent session info = %v", info)
	}
	code, env = call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key, body)
	if code != http.StatusOK {
		t.Fatalf("agent reopen = %d %v", code, env)
	}
	if env["data"].(map[string]any)["id"] != info["id"] {
		t.Fatalf("keyed session not reused: %v vs %v", env["data"], info)
	}
	// 换一个会话名就是另一把 key，不复用。
	code, env = call(t, ts, http.MethodPost, "/api/shell-terminal/sessions", key,
		map[string]string{"agentId": "devin", "sessionName": "tui-two"})
	if code != http.StatusOK || env["data"].(map[string]any)["id"] == info["id"] {
		t.Fatalf("other session = %d %v", code, env)
	}
}

package controller

import (
	"net/http"
	"testing"
)

// TestAgentEnginesListIncludesACPProviders 验证引擎列表以 native 开头，
// 并列出全部外部 ACP 引擎（可用性取决于本机安装）。
func TestAgentEnginesListIncludesACPProviders(t *testing.T) {
	ts, key := newTestServer(t)
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines", key, nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, env)
	}
	list, _ := env["data"].([]any)
	if len(list) != 4 {
		t.Fatalf("engines = %v", list)
	}
	first, _ := list[0].(map[string]any)
	if first["id"] != "native" || first["available"] != true {
		t.Fatalf("first engine = %v", first)
	}
	seen := map[string]bool{}
	for _, entry := range list[1:] {
		engine, _ := entry.(map[string]any)
		id, _ := engine["id"].(string)
		seen[id] = true
		if _, ok := engine["available"].(bool); !ok {
			t.Fatalf("engine %q missing availability: %v", id, engine)
		}
		if _, ok := engine["detail"].(string); !ok {
			t.Fatalf("engine %q missing detail: %v", id, engine)
		}
	}
	for _, id := range []string{"claude-code", "codex", "devin"} {
		if !seen[id] {
			t.Fatalf("engine %q missing from %v", id, list)
		}
	}
}

// TestAgentPreferencesHiddenAgents 验证 PUT /preferences 的 hiddenAgents
// 持久化后反映在引擎列表的 hidden 标记上；未知或 native id 被拒绝。
func TestAgentPreferencesHiddenAgents(t *testing.T) {
	ts, key := newTestServer(t)
	code, env := call(t, ts, http.MethodPut, "/api/agent-engines/preferences", key, map[string]any{
		"hiddenAgents": []string{"codex"},
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, env)
	}
	data, _ := env["data"].(map[string]any)
	if hidden, _ := data["hiddenAgents"].([]any); len(hidden) != 1 || hidden[0] != "codex" {
		t.Fatalf("hiddenAgents = %v", data["hiddenAgents"])
	}

	code, env = call(t, ts, http.MethodGet, "/api/agent-engines", key, nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, env)
	}
	list, _ := env["data"].([]any)
	flags := map[string]bool{}
	for _, entry := range list {
		engine, _ := entry.(map[string]any)
		id, _ := engine["id"].(string)
		flags[id], _ = engine["hidden"].(bool)
	}
	if !flags["codex"] || flags["claude-code"] || flags["devin"] || flags["native"] {
		t.Fatalf("hidden flags = %v", flags)
	}

	for _, ids := range [][]string{{"native"}, {"no-such-agent"}} {
		code, _ = call(t, ts, http.MethodPut, "/api/agent-engines/preferences", key, map[string]any{"hiddenAgents": ids})
		if code != http.StatusBadRequest {
			t.Fatalf("hiddenAgents %v status = %d", ids, code)
		}
	}
	code, _ = call(t, ts, http.MethodPut, "/api/agent-engines/preferences", key, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("empty body status = %d", code)
	}
}

// TestEnginePrepareRejectsUnknownAgent 仍然拒绝未知引擎。
func TestEnginePrepareRejectsUnknownAgent(t *testing.T) {
	ts, key := newTestServer(t)
	code, env := call(t, ts, http.MethodPost, "/api/agent-engines/prepare", key, map[string]any{
		"agentId": "not-an-agent",
	})
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", code, env)
	}
	if env["error"] != "Agent 引擎不可用: not-an-agent" {
		t.Fatalf("error = %v", env["error"])
	}
}

// TestEngineSessionReadsAgentFromMeta 让 GET /agent-engines/session 反映
// 会话绑定的引擎。
func TestEngineSessionReadsAgentFromMeta(t *testing.T) {
	ts, key := newTestServer(t)
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines/session?sessionName=acp-session", key, nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if data, _ := env["data"].(map[string]any); data["agentId"] != "native" {
		t.Fatalf("agentId = %v", data["agentId"])
	}
}

package controller

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestLensReadsSavedExternalHistoryThroughDeclaredSessionService(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	rows := []map[string]any{
		{"role": "user", "content": []any{map[string]any{"type": "text", "text": "HISTORICAL QUESTION"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,SECRET_IMAGE_BYTES"}}}, "timestamp": 123},
		{"role": "assistant", "reasoning_content": "SAVED THOUGHT", "tool_calls": []any{map[string]any{"id": "read-old", "function": map[string]any{"name": "read", "arguments": `{"path":"old.go"}`}}}},
		{"role": "tool", "tool_call_id": "read-old", "content": "OLD TOOL RESULT"},
		{"role": "assistant", "content": "OLD ANSWER"},
		{"role": "user", "content": "HIDDEN INTERNAL CONTENT", "web_hidden": true},
	}
	var log strings.Builder
	for _, row := range rows {
		raw, _ := json.Marshal(row)
		log.Write(raw)
		log.WriteByte('\n')
	}
	if err := os.MkdirAll(s.sessionDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.sessionLogPath("old"), []byte(log.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	s.sessionMetaSet("old", map[string]any{"agentId": "magpie", "model": "unrelated-native-model"})
	scope := map[string]any{"workspaceHash": s.agent.App(), "sessionId": s.agent.App() + "/old"}
	request := func(action string, value map[string]any, selection map[string]any) (int, map[string]any) {
		return call(t, ts, "POST", "/api/plugins/context_lens/request", key, map[string]any{"action": action, "value": value, "context": selection})
	}
	code, env := request("list", nil, scope)
	if code != 200 {
		t.Fatal(env)
	}
	list := env["data"].(map[string]any)["records"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["origin"] != "history" {
		t.Fatal(list)
	}
	id := list[0].(map[string]any)["id"]
	if list[0].(map[string]any)["at"] != float64(123) {
		t.Fatal("history time should come from saved messages rather than file modification time")
	}
	code, env = request("detail", map[string]any{"id": id}, scope)
	raw, _ := json.Marshal(env)
	if code != 200 || !strings.Contains(string(raw), "OLD TOOL RESULT") || !strings.Contains(string(raw), "read · old.go") || !strings.Contains(string(raw), "SAVED THOUGHT") {
		t.Fatalf("detail=%s", raw)
	}
	for _, forbidden := range []string{"SECRET_IMAGE_BYTES", "HIDDEN INTERNAL CONTENT", "unrelated-native-model", `"foldable":true`, `"native":true`} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("unexpected historical data %q: %s", forbidden, raw)
		}
	}
	code, _ = request("detail", map[string]any{"id": id}, map[string]any{"workspaceHash": s.agent.App(), "sessionId": s.agent.App() + "/other"})
	if code == 200 {
		t.Fatal("history detail leaked into a different session")
	}
	data, err := s.pluginSessionRequest(context.Background(), "history", map[string]any{"workspaceHash": s.agent.App(), "sessionName": "old"})
	if err != nil {
		t.Fatal(err)
	}
	revision := data.(map[string]any)["revision"]
	data, err = s.pluginSessionRequest(context.Background(), "history", map[string]any{"workspaceHash": s.agent.App(), "sessionName": "old", "revision": revision})
	if err != nil || data.(map[string]any)["unchanged"] != true {
		t.Fatalf("unchanged=%v %v", data, err)
	}
	for _, value := range []map[string]any{
		{"workspaceHash": "../outside", "sessionName": "old"},
		{"workspaceHash": s.agent.App(), "sessionName": "../old"},
		{"workspaceHash": "unknown-workspace", "sessionName": "old"},
	} {
		if _, err := s.pluginSessionRequest(context.Background(), "history", value); err == nil {
			t.Fatalf("accepted invalid history scope: %v", value)
		}
	}
}

func TestPluginHistoryProjectionBoundsTextAndOmitsMediaWithoutMutatingRows(t *testing.T) {
	text := strings.Repeat("中文", 80000)
	value := map[string]any{"text": text, "image": map[string]any{"type": "base64", "data": "SECRET"}}
	truncated := false
	projected := historyText(value, &truncated).(map[string]any)
	if !truncated || len(projected["text"].(string)) > 128<<10 || value["text"] != text {
		t.Fatal("history projection did not preserve the source or bound long text")
	}
	raw, _ := json.Marshal(projected)
	if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), `\ufffd`) {
		t.Fatalf("unsafe history text: %s", raw)
	}
}

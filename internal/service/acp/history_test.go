package acp

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// 历史投影只保留可移植字段：角色、文本、工具调用与配对信息。
// 图片落成占位符，内部 id、reasoning 与 base64 不进入提示词。
func TestPortableHistoryRowProjectsPortableFields(t *testing.T) {
	rows := []map[string]any{
		{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "看看这张图"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AAAA"}},
		}, "adk_event": "blob", "timestamp": "2024-01-01"},
		{"role": "assistant", "content": "先读文件", "reasoning": "内部推理", "acp_message_id": "m-1",
			"tool_calls": []any{map[string]any{
				"id": "call-1", "type": "function",
				"function": map[string]any{"name": "Read", "arguments": `{"path":"a.txt"}`},
			}}},
		{"role": "tool", "tool_call_id": "call-1", "tool_name": "Read", "content": "file body", "usage": map[string]any{"tokens": 3}},
		{"role": "user", "content": "然后呢", "web_hidden": true},
	}
	prompt, err := historyPrompt(rows, "继续")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(prompt, historyPromptPrefix) || !strings.HasSuffix(prompt, "\n</conversation_history>\n\nCurrent user request:\n继续") {
		t.Fatalf("prompt = %q", prompt)
	}
	body := strings.TrimSuffix(strings.TrimPrefix(prompt, historyPromptPrefix), "\n</conversation_history>\n\nCurrent user request:\n继续")
	var decoded []map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("history rows are not JSON: %v", err)
	}
	if len(decoded) != 3 {
		t.Fatalf("web_hidden row leaked or rows lost: %#v", decoded)
	}
	if decoded[0]["content"] != "看看这张图\n[image omitted]" {
		t.Fatalf("user content = %#v", decoded[0]["content"])
	}
	if decoded[1]["content"] != "先读文件" {
		t.Fatalf("assistant content = %#v", decoded[1]["content"])
	}
	calls, _ := decoded[1]["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %#v", decoded[1]["tool_calls"])
	}
	call, _ := calls[0].(map[string]any)
	fn, _ := call["function"].(map[string]any)
	if call["id"] != "call-1" || call["type"] != "function" || fn["name"] != "Read" || fn["arguments"] != `{"path":"a.txt"}` {
		t.Fatalf("tool call = %#v", call)
	}
	if decoded[2]["tool_call_id"] != "call-1" || decoded[2]["tool_name"] != "Read" || decoded[2]["content"] != "file body" {
		t.Fatalf("tool row = %#v", decoded[2])
	}
	for key, row := range decoded {
		for banned := range map[string]bool{"adk_event": true, "reasoning": true, "acp_message_id": true, "timestamp": true, "usage": true} {
			if _, ok := row[banned]; ok {
				t.Fatalf("row %d carries non-portable field %s: %#v", key, banned, row)
			}
		}
	}
	if strings.Contains(prompt, "AAAA") || strings.Contains(prompt, "内部推理") {
		t.Fatal("prompt leaks base64 or reasoning")
	}
}

func TestHistoryPromptWithoutHistoryReturnsMessage(t *testing.T) {
	for _, rows := range [][]map[string]any{nil, {}, {{"role": "user", "content": "x", "web_hidden": true}}} {
		got, err := historyPrompt(rows, "hello")
		if err != nil || got != "hello" {
			t.Fatalf("rows=%#v got=%q err=%v", rows, got, err)
		}
	}
}

func TestHistorySeedPromptSkipsUnseededAndSeededRemotes(t *testing.T) {
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()}, history: []map[string]any{{"role": "user", "content": "旧对话"}}}
	host.SetMeta("s", map[string]any{"acpHistorySeed": true})

	got, seeding, err := historySeedPrompt(host, "s", "remote-1", "hi")
	if err != nil || !seeding || !strings.Contains(got, "旧对话") {
		t.Fatalf("first remote: got=%q seeding=%v err=%v", got, seeding, err)
	}
	host.SetMeta("s", map[string]any{"acpHistorySeededSessionId": "remote-1"})
	got, seeding, err = historySeedPrompt(host, "s", "remote-1", "hi")
	if err != nil || seeding || got != "hi" {
		t.Fatalf("seeded remote re-seeded: got=%q seeding=%v err=%v", got, seeding, err)
	}
	got, seeding, err = historySeedPrompt(host, "s", "remote-2", "hi")
	if err != nil || !seeding || !strings.Contains(got, "旧对话") {
		t.Fatalf("new remote did not re-seed: got=%q seeding=%v err=%v", got, seeding, err)
	}
	host.SetMeta("s", map[string]any{"acpHistorySeed": false})
	got, seeding, err = historySeedPrompt(host, "s", "remote-3", "hi")
	if err != nil || seeding || got != "hi" {
		t.Fatalf("unseeded session seeded: got=%q seeding=%v err=%v", got, seeding, err)
	}
}

func TestHistorySeedPromptPropagatesHistoryReadFailure(t *testing.T) {
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()}, historyErr: errors.New("disk gone")}
	host.SetMeta("s", map[string]any{"acpHistorySeed": true})
	if _, _, err := historySeedPrompt(host, "s", "remote", "hi"); err == nil || err.Error() != "disk gone" {
		t.Fatalf("err = %v", err)
	}
}

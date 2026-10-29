package controller

import (
	"strings"
	"testing"
)

func TestACPForkPointAtAssistant(t *testing.T) {
	source := []map[string]any{
		{"role": "user", "content": "hello"},
		{"role": "assistant", "content": "answer", "acp_message_id": "m-1"},
		{"role": "user", "content": "again"},
	}
	point, err := acpForkPointAt(source, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(point.lines) != 2 {
		t.Fatalf("lines = %d", len(point.lines))
	}
	fork := point.meta["jetbrains"].(map[string]any)["air"].(map[string]any)["fork"].(map[string]any)
	if fork["messageId"] != "m-1" || fork["messageOccurrence"] != 1 || fork["version"] != 1 {
		t.Fatalf("fork = %+v", fork)
	}
	fingerprint, _ := fork["messageFingerprint"].(string)
	if !strings.HasPrefix(fingerprint, "sha256:") || len(fingerprint) != len("sha256:")+64 {
		t.Fatalf("fingerprint = %q", fingerprint)
	}
}

func TestInheritedSessionMetaKeepsAgentAndModel(t *testing.T) {
	source := map[string]any{
		"agentId": "codex", "acpSessionId": "remote-1", "acpCwd": "/old",
		"title": "原会话", "agentConfig": map[string]any{"model": "gpt-5.4", "mode": "auto"},
		"model": "gpt-5.4", "modelChannelId": "openai", "reasoningEffort": "high",
	}
	meta := inheritedSessionMeta(source, "codex", "remote-2", "/work", "[复刻]原会话")
	if meta["agentId"] != "codex" || meta["acpSessionId"] != "remote-2" || meta["acpCwd"] != "/work" {
		t.Fatalf("identity = %+v", meta)
	}
	if meta["model"] != "gpt-5.4" || meta["modelChannelId"] != "openai" || meta["reasoningEffort"] != "high" {
		t.Fatalf("model = %+v", meta)
	}
	config, _ := meta["agentConfig"].(map[string]any)
	if config["model"] != "gpt-5.4" || config["mode"] != "auto" {
		t.Fatalf("agentConfig = %+v", config)
	}
	withoutRemote := inheritedSessionMeta(source, "codex", "", "/work", "[复刻]原会话")
	if _, ok := withoutRemote["acpSessionId"]; ok {
		t.Fatal("unavailable fork reused the source ACP session")
	}
}

func TestACPForkPointWithoutMessageID(t *testing.T) {
	source := []map[string]any{
		{"role": "user", "content": "hello"},
		{"role": "assistant", "content": "answer"},
	}
	point, err := acpForkPointAt(source, 2)
	if err != nil {
		t.Fatal(err)
	}
	fork := point.meta["jetbrains"].(map[string]any)["air"].(map[string]any)["fork"].(map[string]any)
	if fork["messageId"] != "loopra-history-2" {
		t.Fatalf("messageId = %v", fork["messageId"])
	}
}

func TestACPForkPointRejectsUnstableTail(t *testing.T) {
	source := []map[string]any{
		{"role": "user", "content": "hello"},
		{"role": "assistant", "content": "answer"},
		{"role": "user", "content": "again"},
	}
	// messageCount 指向 assistant：不是一条完整回复。
	if _, err := acpForkPointAt(source, 1); err == nil {
		t.Fatal("should reject non-user boundary")
	}
	// 末尾是工具调用行：无法定位最终消息。
	withTool := []map[string]any{
		{"role": "user", "content": "hello"},
		{"role": "assistant", "tool_calls": []any{map[string]any{"id": "c1"}}},
	}
	if _, err := acpForkPointAt(withTool, 2); err == nil {
		t.Fatal("should reject tool_calls tail")
	}
}

func TestACPForkPointWholeHistory(t *testing.T) {
	source := []map[string]any{{"role": "user", "content": "hello"}}
	point, err := acpForkPointAt(source, 0)
	if err != nil {
		t.Fatal(err)
	}
	if point.meta != nil || len(point.lines) != 1 {
		t.Fatalf("point = %+v", point)
	}
}

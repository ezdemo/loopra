package acp

import (
	"context"
	"errors"
	"testing"
)

// configRecorder 记录恢复会话时下发给 Agent 的配置。
type configRecorder struct {
	accepted map[string]bool
	sent     []string
}

func (c *configRecorder) SetConfigOption(_ context.Context, id string, value any) ([]ConfigOption, error) {
	c.sent = append(c.sent, id)
	if c.accepted != nil && !c.accepted[id] {
		return nil, errors.New("unsupported option")
	}
	return []ConfigOption{{ID: id, CurrentValue: value}}, nil
}

func metaWithConfig(values map[string]any) map[string]any {
	return map[string]any{"agentConfig": values, "agentId": "codex"}
}

// TestRestoreSessionConfigReappliesSavedChoices 覆盖重启后打开会话的场景：
// Agent 恢复会话时回的是它自己的默认值，保存的选择必须重新下发并留在 .meta 里。
func TestRestoreSessionConfigReappliesSavedChoices(t *testing.T) {
	meta := metaWithConfig(map[string]any{
		"model": "auto/gpt-6.1-sol",
		"mode":  "agent-full-access",
	})
	defaults := []ConfigOption{
		{ID: "model", CurrentValue: "auto/gpt-5.6-luna"},
		{ID: "mode", CurrentValue: "agent"},
	}
	writer := &configRecorder{}
	options, config := restoreSessionConfig(context.Background(), writer, meta, defaults)

	if config["model"] != "auto/gpt-6.1-sol" || config["mode"] != "agent-full-access" {
		t.Fatalf("agentConfig = %+v", config)
	}
	if len(writer.sent) != 2 {
		t.Fatalf("sent = %v", writer.sent)
	}
	values := configValues(options)
	if values["model"] != "auto/gpt-6.1-sol" || values["mode"] != "agent-full-access" {
		t.Fatalf("options = %+v", options)
	}
}

// TestRestoreSessionConfigKeepsValuesTheAgentRejects 保证 Agent 换了版本后不再接受的
// 保存值不会被抹掉，下次恢复还能再试。
func TestRestoreSessionConfigKeepsValuesTheAgentRejects(t *testing.T) {
	meta := metaWithConfig(map[string]any{"model": "auto/gpt-6.1-sol", "mode": "agent-full-access"})
	defaults := []ConfigOption{
		{ID: "model", CurrentValue: "auto/gpt-5.6-luna"},
		{ID: "mode", CurrentValue: "agent"},
	}
	writer := &configRecorder{accepted: map[string]bool{"mode": true}}
	_, config := restoreSessionConfig(context.Background(), writer, meta, defaults)

	if config["mode"] != "agent-full-access" {
		t.Fatalf("accepted value lost: %+v", config)
	}
	if config["model"] != "auto/gpt-6.1-sol" {
		t.Fatalf("rejected value lost: %+v", config)
	}
}

// TestRestoreSessionConfigSkipsMatchingValues 确认配置已经一致时不会重复下发。
func TestRestoreSessionConfigSkipsMatchingValues(t *testing.T) {
	meta := metaWithConfig(map[string]any{"model": "auto/gpt-6.1-sol"})
	writer := &configRecorder{}
	restoreSessionConfig(context.Background(), writer, meta,
		[]ConfigOption{{ID: "model", CurrentValue: "auto/gpt-6.1-sol"}})

	if len(writer.sent) != 0 {
		t.Fatalf("sent = %v", writer.sent)
	}
}

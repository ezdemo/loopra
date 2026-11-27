package acp

import (
	"context"
	"errors"
	"testing"
)

// configRecorder 记录下发给 Agent 的配置，并维护一份当前完整目录：
// v1 语义里每次 set 的回包就是全量快照（替换语义），catalog 钩子还能模拟
// 换模型后选项消失 / 新增的 Agent 行为。
type configRecorder struct {
	accepted map[string]bool
	sent     []string
	values   []any
	options  []ConfigOption
	// catalog 在每次 set 之后返回新的完整列表；nil 时原地改值返回。
	catalog func(id string, value any, current []ConfigOption) []ConfigOption
}

func (c *configRecorder) SetConfigOption(_ context.Context, id string, value any) ([]ConfigOption, error) {
	c.sent = append(c.sent, id)
	c.values = append(c.values, value)
	if c.accepted != nil && !c.accepted[id] {
		return nil, errors.New("unsupported option")
	}
	if c.catalog != nil {
		c.options = c.catalog(id, value, c.options)
		return append([]ConfigOption(nil), c.options...), nil
	}
	next := append([]ConfigOption(nil), c.options...)
	for i := range next {
		if next[i].ID == id {
			next[i].CurrentValue = value
		}
	}
	c.options = next
	return next, nil
}

func metaWithConfig(values map[string]any) map[string]any {
	return map[string]any{"agentConfig": values, "agentId": "codex"}
}

// TestRestoreSessionConfigAppliesModelFirst 目录故意把 effort/mode 排在 model 前：
// 恢复仍必须先下发 model，否则依附模型的选项会按旧模型的取值范围发出去。
// 同时验证 v1 替换语义：换模型后 catalog 删掉 effort、新增 thought，
// 过时的 effort 不再出现在最终列表，保存值也无从下发。
func TestRestoreSessionConfigAppliesModelFirst(t *testing.T) {
	meta := metaWithConfig(map[string]any{
		"model":   "gpt-6.1-sol",
		"effort":  "high",
		"mode":    "full",
		"thought": "on",
	})
	defaults := []ConfigOption{
		{ID: "effort", Category: "thought_level", Type: "select", CurrentValue: "auto"},
		{ID: "mode", Category: "mode", Type: "select", CurrentValue: "agent"},
		{ID: "model", Category: "model", Type: "select", CurrentValue: "gpt-5.6"},
	}
	// 新模型的目录：effort 被废弃，thought 是依附新模型才出现的选项。
	switched := []ConfigOption{
		{ID: "thought", Category: "thought", Type: "select", CurrentValue: "auto"},
		{ID: "mode", Category: "mode", Type: "select", CurrentValue: "agent"},
		{ID: "model", Category: "model", Type: "select", CurrentValue: "gpt-6.1-sol"},
	}
	writer := &configRecorder{
		options: defaults,
		catalog: func(id string, value any, current []ConfigOption) []ConfigOption {
			if id == "model" {
				return switched
			}
			next := append([]ConfigOption(nil), current...)
			for i := range next {
				if next[i].ID == id {
					next[i].CurrentValue = value
				}
			}
			return next
		},
	}
	options, config := restoreSessionConfig(context.Background(), writer, meta, defaults)

	if len(writer.sent) == 0 || writer.sent[0] != "model" {
		t.Fatalf("model 必须先下发: sent=%v", writer.sent)
	}
	for _, id := range writer.sent {
		if id == "effort" {
			t.Fatalf("换模型后已废弃的 effort 不应再下发: sent=%v", writer.sent)
		}
	}
	got := map[string]bool{}
	for _, id := range writer.sent {
		got[id] = true
	}
	if !got["mode"] || !got["thought"] {
		t.Fatalf("mode/thought 未下发: sent=%v", writer.sent)
	}
	// 最终列表是最后一次回包的完整快照：过时的 effort 已不在其中。
	values := configValues(options)
	if _, stale := values["effort"]; stale {
		t.Fatalf("stale effort 不应留在最终快照: %+v", options)
	}
	if values["model"] != "gpt-6.1-sol" || values["mode"] != "full" || values["thought"] != "on" {
		t.Fatalf("options = %+v", options)
	}
	// 保存值优先：effort 用户设置过，即使本次没机会下发也留在 .meta 里。
	if config["effort"] != "high" {
		t.Fatalf("rejected/unavailable saved value lost: %+v", config)
	}
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
	writer := &configRecorder{options: defaults}
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
	writer := &configRecorder{options: defaults, accepted: map[string]bool{"mode": true}}
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
	writer := &configRecorder{options: []ConfigOption{{ID: "model", CurrentValue: "auto/gpt-6.1-sol"}}}
	restoreSessionConfig(context.Background(), writer, meta,
		[]ConfigOption{{ID: "model", CurrentValue: "auto/gpt-6.1-sol"}})

	if len(writer.sent) != 0 {
		t.Fatalf("sent = %v", writer.sent)
	}
}

// TestApplyAgentConfigTypesBoolean boolean 选项的保存值是字符串，下发时必须
// 转成真正的 bool；非法布尔值直接跳过该项。
func TestApplyAgentConfigTypesBoolean(t *testing.T) {
	writer := &configRecorder{options: []ConfigOption{
		{ID: "verbose", Type: "boolean", CurrentValue: false},
		{ID: "legacy", Type: "boolean", CurrentValue: false},
	}}
	options := ApplyAgentConfig(context.Background(), writer,
		map[string]string{"verbose": "true", "legacy": "not-a-bool"},
		[]ConfigOption{
			{ID: "verbose", Type: "boolean", CurrentValue: false},
			{ID: "legacy", Type: "boolean", CurrentValue: false},
		})

	if len(writer.sent) != 1 || writer.sent[0] != "verbose" {
		t.Fatalf("非法布尔值不应下发: sent=%v", writer.sent)
	}
	flag, ok := writer.values[0].(bool)
	if !ok || !flag {
		t.Fatalf("boolean 保存值应转成 bool 下发: %#v", writer.values[0])
	}
	if v, _ := options[0].CurrentValue.(bool); !v {
		t.Fatalf("options = %+v", options)
	}
}

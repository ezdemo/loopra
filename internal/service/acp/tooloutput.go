package acp

import (
	"encoding/json"
	"strconv"
	"strings"
)

// ToolOutput 保留 ACP 工具的增量输出，直到状态型完成更新到达
// （Java AcpToolOutput）。
//
// ACP 允许终端输出以 terminal_output_delta 追加、以 rawOutput/exit_code
// 收尾，而一次更新里往往只带其中一部分；因此这里累积而不是覆盖。
type ToolOutput struct {
	terminal strings.Builder
	progress strings.Builder
	raw      any
	hasRaw   bool
	content  string
	exitCode *int
	signal   string
}

// Update 吸收一次工具更新。blocks 来自 content 数组，
// meta 是更新上的 _meta。
func (o *ToolOutput) Update(raw any, blocks []ToolCallItem, meta map[string]any) {
	if raw != nil {
		o.raw = raw
		o.hasRaw = true
		if value, ok := raw.(map[string]any); ok {
			o.readExit(value)
		}
	}
	if blocks != nil {
		parts := make([]string, 0, len(blocks))
		for _, item := range blocks {
			if item.Type == "content" && item.Content != nil && item.Content.Text != "" {
				parts = append(parts, item.Content.Text)
			}
		}
		o.content = strings.Join(parts, "\n")
	}
	if meta == nil {
		return
	}
	// 两种适配器约定都是追加式分片；同时给出两个别名时优先显式 delta。
	chunk, ok := metaData(meta["terminal_output_delta"])
	if !ok {
		chunk, ok = metaData(meta["terminal_output"])
	}
	if ok {
		o.terminal.WriteString(chunk)
	}
	if mcp, ok := metaData(meta["mcp_output_delta"]); ok {
		o.progress.WriteString(mcp)
	}
	if value, ok := meta["terminal_exit"].(map[string]any); ok {
		o.readExit(value)
	}
}

// Text 返回当前累积的文本结果。
func (o *ToolOutput) Text() string {
	exitOnly := false
	if value, ok := o.raw.(map[string]any); ok {
		exitOnly = true
		for key := range value {
			if key != "exit_code" && key != "signal" {
				exitOnly = false
				break
			}
		}
	}
	var body string
	switch {
	case o.terminal.Len() > 0:
		body = o.terminal.String()
	case o.hasRaw && !exitOnly && !isEmptyString(o.raw):
		if text, ok := o.raw.(string); ok {
			body = text
		} else if raw, err := json.Marshal(o.raw); err == nil {
			body = string(raw)
		}
	case o.content != "":
		body = o.content
	default:
		body = o.progress.String()
	}
	if o.exitCode == nil && o.signal == "" {
		return body
	}
	var summary string
	if o.exitCode != nil {
		summary = "Exit code: " + strconv.Itoa(*o.exitCode)
	}
	if o.signal != "" {
		if summary != "" {
			summary += ", "
		}
		summary += "Signal: " + o.signal
	}
	if body == "" {
		return summary
	}
	if strings.HasSuffix(body, "\n") {
		return body + "\n" + summary
	}
	return body + "\n\n" + summary
}

// Failed 报告进程退出码或信号是否表示失败。
func (o *ToolOutput) Failed() bool {
	return (o.exitCode != nil && *o.exitCode != 0) || o.signal != ""
}

func (o *ToolOutput) readExit(value map[string]any) {
	if code, ok := numberToInt(value["exit_code"]); ok {
		o.exitCode = &code
	}
	if text, ok := value["signal"].(string); ok && strings.TrimSpace(text) != "" {
		o.signal = text
	}
}

func metaData(value any) (string, bool) {
	chunk, ok := value.(map[string]any)
	if !ok {
		return "", false
	}
	text, ok := chunk["data"].(string)
	return text, ok
}

func isEmptyString(value any) bool {
	text, ok := value.(string)
	return ok && text == ""
}

func numberToInt(value any) (int, bool) {
	switch n := value.(type) {
	case float64:
		return int(n), true
	case float32:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	case json.Number:
		v, err := n.Int64()
		return int(v), err == nil
	default:
		return 0, false
	}
}

package acp

import (
	"encoding/json"
	"strings"
)

const historyContextPrefix = "Prior conversation (transcript data):\n"

// historySeedBlock 返回只在远端首次接收当前会话历史时发送的上下文块。
func historySeedBlock(host SessionHost, session, remote string) (string, bool, error) {
	meta := host.Meta(session)
	if meta["acpHistorySeed"] != true || strOr(meta, "acpHistorySeededSessionId", "") == remote {
		return "", false, nil
	}
	rows, err := host.History(session)
	if err != nil {
		return "", false, err
	}
	text, err := historyContext(rows)
	if err != nil {
		return "", false, err
	}
	return text, true, nil
}

// historyContext 把历史投影为可移植的对话数据，不改写当前用户消息。
func historyContext(rows []map[string]any) (string, error) {
	projected := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if row["web_hidden"] == true {
			continue
		}
		projected = append(projected, portableHistoryRow(row))
	}
	if len(projected) == 0 {
		return "", nil
	}
	encoded, err := json.Marshal(projected)
	if err != nil {
		return "", err
	}
	return historyContextPrefix + string(encoded) + "\n\n", nil
}

// portableHistoryRow 只保留对另一个引擎有意义的字段：role、文本内容
// （图片落成占位符）、助手的 tool_calls 和工具行的配对信息。内部 id、
// 模型特有的 reasoning/签名、计时、用量与原始 base64 一律不带走。
func portableHistoryRow(row map[string]any) map[string]any {
	role, _ := row["role"].(string)
	out := map[string]any{"role": role}
	if content := portableContent(row["content"]); content != "" {
		out["content"] = content
	}
	switch role {
	case "assistant":
		if calls := portableToolCalls(row["tool_calls"]); len(calls) > 0 {
			out["tool_calls"] = calls
		}
	case "tool":
		if id, _ := row["tool_call_id"].(string); id != "" {
			out["tool_call_id"] = id
		}
		if name, _ := row["tool_name"].(string); name != "" {
			out["tool_name"] = name
		}
	}
	return out
}

// portableContent 提取行的文本内容：字符串原样保留，分段内容取文本部分，
// 图片段替换为占位符，不携带 base64 或远端 url。
func portableContent(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			switch part["type"] {
			case "text":
				if text, ok := part["text"].(string); ok && text != "" {
					parts = append(parts, text)
				}
			case "image_url", "image":
				parts = append(parts, "[image omitted]")
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

// portableToolCalls 投影 tool_calls 为 {id, type, function:{name, arguments}}。
func portableToolCalls(raw any) []map[string]any {
	calls, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(calls))
	for _, item := range calls {
		call, ok := item.(map[string]any)
		if !ok {
			continue
		}
		entry := map[string]any{}
		if id, _ := call["id"].(string); id != "" {
			entry["id"] = id
		}
		if typ, _ := call["type"].(string); typ != "" {
			entry["type"] = typ
		}
		if fn, ok := call["function"].(map[string]any); ok {
			projected := map[string]any{}
			if name, _ := fn["name"].(string); name != "" {
				projected["name"] = name
			}
			if args, _ := fn["arguments"].(string); args != "" {
				projected["arguments"] = args
			}
			if len(projected) > 0 {
				entry["function"] = projected
			}
		}
		if len(entry) > 0 {
			out = append(out, entry)
		}
	}
	return out
}

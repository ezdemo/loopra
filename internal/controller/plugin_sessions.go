package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	sessfiles "github.com/ezdemo/looprax/internal/service/session"
)

// This read-only capability exposes saved conversation rows, never a rebuilt
// model request or current project instructions presented as historical facts.
func (s *Controller) pluginSessionRequest(ctx context.Context, action string, value map[string]any) (any, error) {
	if action != "history" {
		return nil, fmt.Errorf("不支持的会话读取操作")
	}
	app, _ := value["workspaceHash"].(string)
	name, _ := value["sessionName"].(string)
	for _, part := range []string{app, name} {
		if part == "" || part == "." || part == ".." || filepath.Base(part) != part || strings.ContainsAny(part, `/\\`) {
			return nil, fmt.Errorf("项目和会话名称无效")
		}
	}
	if _, err := s.resolveProject(app); err != nil {
		return nil, err
	}
	store := sessfiles.Open(s.home, app)
	info, err := os.Stat(store.LogPath(name))
	if os.IsNotExist(err) {
		return map[string]any{"messages": []any{}, "revision": "missing"}, nil
	}
	if err != nil {
		return nil, err
	}
	revision := fmt.Sprintf("%d-%d", info.ModTime().UnixNano(), info.Size())
	if value["revision"] == revision {
		return map[string]any{"unchanged": true, "revision": revision}, nil
	}
	rows := store.Messages(name)
	at := info.ModTime().UnixMilli()
	for i := len(rows) - 1; i >= 0; i-- {
		if timestamp := number(rows[i]["timestamp"]); timestamp > 0 {
			at = timestamp
			break
		}
	}
	truncated := len(rows) > 1200
	if truncated {
		rows = rows[len(rows)-1200:]
	}
	// Bound the bridge payload and omit media bytes before they enter JavaScript.
	messages, size := []map[string]any{}, 0
	for i := len(rows) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for _, key := range []string{"role", "content", "reasoning_content", "tool_calls", "tool_call_id", "tool_name", "timestamp"} {
			if v, ok := rows[i][key]; ok {
				row[key] = historyText(v, &truncated)
			}
		}
		raw, _ := json.Marshal(row)
		if size+len(raw) > 3<<20 {
			truncated = true
			break
		}
		size += len(raw)
		messages = append(messages, row)
	}
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	meta := store.ReadMeta(name)
	agentID := strOr(meta, "agentId", "")
	native, model := agentID == "" || agentID == "native", ""
	if native {
		model = strOr(meta, "model", "")
	}
	return map[string]any{"messages": messages, "revision": revision, "at": at, "truncated": truncated,
		"model": model, "agentId": agentID, "native": native}, nil
}

func historyText(value any, truncated *bool) any {
	switch v := value.(type) {
	case string:
		if strings.HasPrefix(v, "data:") {
			return "[媒体原始数据省略]"
		}
		if len(v) > 128<<10 {
			v = v[:128<<10]
			for !utf8.ValidString(v) {
				v = v[:len(v)-1]
			}
			*truncated = true
		}
		return v
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = historyText(item, truncated)
		}
		return out
	case map[string]any:
		kind, _ := v["type"].(string)
		if strings.Contains(kind, "image") || strings.Contains(kind, "audio") || kind == "base64" || kind == "file" {
			return map[string]any{"type": kind}
		}
		out := map[string]any{}
		for key, item := range v {
			out[key] = historyText(item, truncated)
		}
		return out
	default:
		return v
	}
}

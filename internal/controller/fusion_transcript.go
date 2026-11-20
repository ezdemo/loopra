package controller

import (
	"encoding/json"
	"path/filepath"
)

// fusionInlineSink 把 Fusion 执行代理的 sub_* 事件就地翻译为父聊天的
// 普通 SSE 事件：进度不再放进子代理容器，而是带 segmentId 的
// 正文/思考与以 fusion: 前缀命名空间的工具调用。
type fusionInlineSink struct {
	sse       *sseWriter
	sessionID string
}

func (s *fusionInlineSink) SendSub(event string, payload map[string]any) {
	if event == "sub_start" {
		s.sessionID, _ = payload["subSessionId"].(string)
		return
	}
	if kind, inline := fusionInlineEvent(s.sessionID, event, payload); kind != "" {
		s.sse.send(kind, inline)
	}
}

// Fusion reuses the child runner for isolated execution and audit, not for UI.
func fusionInlineEvent(id, event string, payload map[string]any) (string, map[string]any) {
	switch event {
	case "sub_content", "sub_reasoning":
		text, _ := payload["token"].(string)
		if text == "" {
			text, _ = payload["content"].(string)
		}
		return event[4:], map[string]any{"content": text, "segmentId": id}
	case "sub_tool_call", "sub_tool_update", "sub_tool_result", "sub_choice", "sub_permission_resolved":
		inline := make(map[string]any, len(payload))
		for key, value := range payload {
			switch key {
			case "type", "subId", "subSessionId":
				continue
			}
			inline[key] = value
		}
		if callID, _ := inline["toolCallId"].(string); callID != "" {
			inline["toolCallId"] = "fusion:" + id + ":" + callID
		}
		return event[4:], inline
	default:
		// The delegate result reports failures; the parent already emits file changes.
		return "", nil
	}
}

// isFusionTranscript 识别 Fusion 执行审计：首行 sub_start 带
// resumable:false。这类日志不进子会话列表，历史通过 fusion_events 回放。
func isFusionTranscript(events []subEvent) bool {
	return len(events) > 0 && events[0]["type"] == "sub_start" && events[0]["resumable"] == false
}

// withFusionTranscript 把历史里 fusion_delegate 的工具行还原为
// 普通呈现：信封拆出回复文本与状态，并按 .sub 审计附上前端的
// fusion_events（与实时流相同形状的就地事件）。
func (s *Controller) withFusionTranscript(name string, rows []map[string]any) []map[string]any {
	for _, row := range rows {
		if row["role"] != "tool" || row["tool_name"] != fusionDelegateName {
			continue
		}
		// The stored result is already an envelope with the audit ID; keep the
		// model-facing JSONL and visible history row counts untouched.
		var result struct {
			Reply     string `json:"result"`
			Status    string `json:"status"`
			SessionID string `json:"subSessionId"`
		}
		raw, _ := row["content"].(string)
		if json.Unmarshal([]byte(raw), &result) != nil || result.Status == "" {
			continue
		}
		row["content"] = result.Reply
		if result.Status == "failed" || result.Status == "aborted" {
			row["tool_status"] = "failed"
		} else {
			row["tool_status"] = "completed"
		}
		if !subSessionIDPattern.MatchString(result.SessionID) {
			continue
		}
		audit, err := readSubEvents(filepath.Join(s.subSessionsDir(name), result.SessionID+".jsonl"))
		if err != nil || !isFusionTranscript(audit) {
			continue
		}
		var events []map[string]any
		for _, e := range audit {
			kind, _ := e["type"].(string)
			if kind, inline := fusionInlineEvent(result.SessionID, kind, e); kind != "" {
				inline["type"] = kind
				events = append(events, inline)
			}
		}
		if len(events) > 0 {
			row["fusion_events"] = events
		}
	}
	return rows
}

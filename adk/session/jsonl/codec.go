package jsonl

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/session"
)

// eventLines 使用 Loopra 的 snake_case 消息格式把一个 ADK 事件
// 转换为 JSONL 行。压缩事件会变为 system 行，使压缩记录
// 能在往返转换后保留（这是 ADK 一致性测试套件
// 与恢复正确性所要求的）。
func eventLines(ev *session.Event) []map[string]any {
	base := map[string]any{
		"event_id":  ev.ID,
		"timestamp": ev.Timestamp.UnixMilli(),
		"adk_ts":    ev.Timestamp.UnixNano(),
	}
	if ev.InvocationID != "" {
		base["adk_invocation"] = ev.InvocationID
	}
	if needsBlob(ev) {
		if raw, err := json.Marshal(ev); err == nil {
			base["adk_event"] = json.RawMessage(raw)
		}
	}
	if ev.Content == nil {
		if len(base) > 2 || ev.Actions.Compaction != nil {
			line := cloneMap(base)
			line["role"] = "system"
			return []map[string]any{line}
		}
		return nil
	}
	if hidden(ev) {
		base["web_hidden"] = true
	}
	role := ev.Author
	if ev.Content.Role == genai.RoleModel {
		role = "model"
	}
	switch role {
	case "model":
		line := cloneMap(base)
		line["role"] = "assistant"
		var texts, thoughts []string
		var calls []map[string]any
		for _, p := range ev.Content.Parts {
			if p == nil {
				continue
			}
			switch {
			case p.Text != "" && p.Thought:
				thoughts = append(thoughts, p.Text)
			case p.Text != "":
				texts = append(texts, p.Text)
			case p.FunctionCall != nil:
				args := "{}"
				if p.FunctionCall.Args != nil {
					if raw, err := json.Marshal(p.FunctionCall.Args); err == nil {
						args = string(raw)
					}
				}
				calls = append(calls, map[string]any{
					"id":   orDefault(p.FunctionCall.ID, "unknown"),
					"type": "function",
					"function": map[string]any{
						"name":      p.FunctionCall.Name,
						"arguments": args,
					},
				})
			}
		}
		if len(texts) > 0 {
			line["content"] = strings.Join(texts, "\n")
		}
		if len(thoughts) > 0 {
			line["reasoning_content"] = strings.Join(thoughts, "\n")
		}
		if len(calls) > 0 {
			line["tool_calls"] = calls
		}
		return []map[string]any{line}
	default: // user，或智能体以 user 身份写入
		var lines []map[string]any
		var userTexts []string
		var images []string
		var calls []map[string]any
		for _, p := range ev.Content.Parts {
			if p == nil {
				continue
			}
			switch {
			case p.FunctionResponse != nil:
				tool := cloneMap(base)
				tool["role"] = "tool"
				tool["tool_call_id"] = p.FunctionResponse.ID
				tool["content"] = resultText(p.FunctionResponse)
				// 保留 ADK 的响应名称与原始负载（Java
				// 读取方会忽略这些键）；审批恢复
				// 协议需要它们原样保留。
				if p.FunctionResponse.Name != "" {
					tool["tool_name"] = p.FunctionResponse.Name
				}
				if p.FunctionResponse.Response != nil {
					if raw, err := json.Marshal(p.FunctionResponse.Response); err == nil {
						tool["adk_response"] = string(raw)
					}
				}
				lines = append(lines, tool)
			case p.FunctionCall != nil:
				// 智能体编写的审批请求（例如
				// adk_request_confirmation）会落在这里；把它们持久化为
				// assistant 的 tool_calls 行，以便恢复处理器在
				// 重新加载后找到它们。
				args := "{}"
				if p.FunctionCall.Args != nil {
					if raw, err := json.Marshal(p.FunctionCall.Args); err == nil {
						args = string(raw)
					}
				}
				calls = append(calls, map[string]any{
					"id":   orDefault(p.FunctionCall.ID, "unknown"),
					"type": "function",
					"function": map[string]any{
						"name":      p.FunctionCall.Name,
						"arguments": args,
					},
				})
			case p.Text != "" && !p.Thought:
				userTexts = append(userTexts, p.Text)
			case p.InlineData != nil:
				images = append(images, dataURL(p.InlineData.MIMEType, p.InlineData.Data))
			case p.FileData != nil && p.FileData.FileURI != "":
				images = append(images, p.FileData.FileURI)
			}
		}
		if len(calls) > 0 {
			line := cloneMap(base)
			line["role"] = "assistant"
			line["tool_calls"] = calls
			lines = append(lines, line)
		}
		if len(userTexts) > 0 || len(images) > 0 {
			user := cloneMap(base)
			user["role"] = "user"
			if len(images) == 0 {
				user["content"] = strings.Join(userTexts, "\n")
			} else {
				content := make([]any, 0, len(userTexts)+len(images))
				for _, t := range userTexts {
					content = append(content, map[string]any{"type": "text", "text": t})
				}
				for _, img := range images {
					content = append(content, map[string]any{
						"type":      "image_url",
						"image_url": map[string]any{"url": img},
					})
				}
				user["content"] = content
			}
			lines = append(lines, user)
		}
		return lines
	}
}

// lineEvent 从一行 JSONL 重建 ADK 事件。对没有 ID 的行，seq
// 提供按行分配的确定性 ID（Java 写入的文件）。
func lineEvent(m map[string]any, seq int) *session.Event {
	if raw, ok := m["adk_event"]; ok {
		data, err := json.Marshal(raw)
		if err == nil {
			ev := &session.Event{}
			if json.Unmarshal(data, ev) == nil {
				if ev.ID == "" {
					if id, _ := m["event_id"].(string); id != "" {
						ev.ID = id
					} else {
						ev.ID = "evt-" + itoa(seq)
					}
				}
				return ev
			}
		}
	}
	ev := &session.Event{}
	if id, _ := m["event_id"].(string); id != "" {
		ev.ID = id
	} else {
		ev.ID = "evt-" + itoa(seq)
	}
	if ts, ok := toInt64(m["adk_ts"]); ok {
		ev.Timestamp = time.Unix(0, ts)
	} else if ts, ok := toInt64(m["timestamp"]); ok {
		ev.Timestamp = time.UnixMilli(ts)
	}
	if inv, _ := m["adk_invocation"].(string); inv != "" {
		ev.InvocationID = inv
	}
	if _, ok := m["web_hidden"]; ok {
		ev.CustomMetadata = map[string]any{"webHidden": true}
	}
	role, _ := m["role"].(string)
	switch role {
	case "system":
		if raw, ok := m["adk_compaction"].(string); ok {
			var comp session.EventCompaction
			if err := json.Unmarshal([]byte(raw), &comp); err == nil {
				ev.Actions.Compaction = &comp
			}
		}
		if author, _ := m["adk_author"].(string); author != "" {
			ev.Author = author
		} else {
			ev.Author = "model"
		}
		ev.Content = &genai.Content{Role: genai.RoleUser, Parts: textParts(stringValue(m["content"]))}
		return ev
	case "assistant":
		ev.Author = "model"
		parts := make([]*genai.Part, 0)
		if reasoning, ok := m["reasoning_content"].(string); ok && reasoning != "" {
			parts = append(parts, &genai.Part{Text: reasoning, Thought: true})
		}
		parts = append(parts, textParts(stringValue(m["content"]))...)
		if rawCalls, ok := m["tool_calls"].([]any); ok {
			for _, raw := range rawCalls {
				call, _ := raw.(map[string]any)
				if call == nil {
					continue
				}
				fn, _ := call["function"].(map[string]any)
				if fn == nil {
					continue
				}
				name, _ := fn["name"].(string)
				if name == "" {
					continue
				}
				args := map[string]any{}
				if argStr, _ := fn["arguments"].(string); argStr != "" {
					_ = json.Unmarshal([]byte(argStr), &args)
				}
				id, _ := call["id"].(string)
				parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{
					ID: orDefault(id, "unknown"), Name: name, Args: args,
				}})
			}
		}
		ev.Content = &genai.Content{Role: genai.RoleModel, Parts: parts}
		return ev
	case "tool":
		ev.Author = "user"
		id, _ := m["tool_call_id"].(string)
		fr := &genai.FunctionResponse{
			ID: id, Response: map[string]any{"result": stringValue(m["content"])},
		}
		if name, _ := m["tool_name"].(string); name != "" {
			fr.Name = name
		}
		if raw, _ := m["adk_response"].(string); raw != "" {
			var resp map[string]any
			if json.Unmarshal([]byte(raw), &resp) == nil {
				fr.Response = resp
			}
		}
		ev.Content = &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: fr}}}
		return ev
	default: // 用户
		ev.Author = "user"
		var parts []*genai.Part
		switch content := m["content"].(type) {
		case string:
			parts = textParts(content)
		case []any:
			for _, raw := range content {
				item, _ := raw.(map[string]any)
				if item == nil {
					continue
				}
				switch item["type"] {
				case "text":
					parts = append(parts, &genai.Part{Text: stringValue(item["text"])})
				case "image_url":
					url := nestedString(item, "image_url", "url")
					if url == "" {
						continue
					}
					if mime, data, ok := parseDataURL(url); ok {
						parts = append(parts, &genai.Part{InlineData: &genai.Blob{MIMEType: mime, Data: data}})
					} else {
						parts = append(parts, &genai.Part{FileData: &genai.FileData{FileURI: url}})
					}
				}
			}
		}
		ev.Content = &genai.Content{Role: genai.RoleUser, Parts: parts}
		return ev
	}
}

func textParts(s string) []*genai.Part {
	if s == "" {
		return nil
	}
	return []*genai.Part{{Text: s}}
}

func hidden(ev *session.Event) bool {
	v, ok := ev.CustomMetadata["webHidden"]
	return ok && (v == true || v == "true")
}

func resultText(fr *genai.FunctionResponse) string {
	if fr.Response == nil {
		return ""
	}
	if len(fr.Response) == 1 {
		if s, ok := fr.Response["result"].(string); ok {
			return s
		}
	}
	raw, err := json.Marshal(fr.Response)
	if err != nil {
		return ""
	}
	return string(raw)
}

func dataURL(mime string, data []byte) string {
	if mime == "" {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

// parseDataURL 解码 "data:<mime>;base64,<payload>"。
func parseDataURL(url string) (string, []byte, bool) {
	if !strings.HasPrefix(url, "data:") {
		return "", nil, false
	}
	rest := url[len("data:"):]
	sep := strings.Index(rest, ",")
	if sep < 0 {
		return "", nil, false
	}
	meta := rest[:sep]
	payload := rest[sep+1:]
	mime := strings.TrimSuffix(meta, ";base64")
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", nil, false
	}
	return mime, data, true
}

func stringValue(v any) string {
	s, _ := v.(string)
	return s
}

func nestedString(m map[string]any, outer, inner string) string {
	o, _ := m[outer].(map[string]any)
	if o == nil {
		return ""
	}
	s, _ := o[inner].(string)
	return s
}

func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func itoa(i int) string {
	return strconv.Itoa(i)
}

// needsBlob 判断事件是否携带了 Loopra 行映射会丢弃的字段；
// 这类事件会把完整 JSON 嵌入 "adk_event"，以保证 ADK
// 一致性往返成立。Java 读取方会忽略该额外键。
func needsBlob(ev *session.Event) bool {
	r := ev.LLMResponse
	if ev.Actions.Compaction != nil || ev.Actions.SkipSummarization ||
		ev.Actions.TransferToAgent != "" || ev.Actions.Escalate ||
		len(ev.Actions.ArtifactDelta) > 0 || len(ev.Actions.RequestedToolConfirmations) > 0 ||
		len(ev.Actions.StateDelta) > 0 {
		return true
	}
	if ev.Branch != "" || ev.IsolationScope != "" || len(ev.LongRunningToolIDs) > 0 {
		return true
	}
	if r.ErrorCode != "" || r.ErrorMessage != "" || r.Interrupted || r.ModelVersion != "" ||
		r.CitationMetadata != nil || r.GroundingMetadata != nil || r.UsageMetadata != nil ||
		r.FinishReason != "" || r.SessionResumptionHandle != "" {
		return true
	}
	for k := range r.CustomMetadata {
		if k != "webHidden" {
			return true
		}
	}
	if ev.Content != nil {
		for _, p := range ev.Content.Parts {
			if p != nil && len(p.ThoughtSignature) > 0 {
				return true
			}
		}
	}
	return false
}

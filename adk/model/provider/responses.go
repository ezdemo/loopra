package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"strings"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

// responsesAdapter 基于 OpenAI Responses API 实现 model.LLM。
type responsesAdapter struct {
	config Config
}

func (a *responsesAdapter) Name() string { return a.config.DefaultModel }

func (a *responsesAdapter) Protocol() string { return ProtocolResponses }

func (a *responsesAdapter) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		snap := a.config.Settings.Snapshot()
		headers, err := a.config.authAndExtraHeaders(snap)
		if err != nil {
			yield(nil, err)
			return
		}
		tracker := newCallIDTracker()
		built, buildErr := a.buildBody(req, tracker, snap, stream)
		body, err := outgoingBody(req, built, buildErr)
		if err != nil {
			yield(nil, err)
			return
		}
		start := time.Now()
		modelName := a.config.modelName(req)
		resp, err := postJSON(withRequestObserver(ctx, req), a.config.Client, "POST", a.config.Endpoint, headers, body, stream)
		logModelCall("responses", start, modelName, stream, err)
		if err != nil {
			yield(nil, err)
			return
		}
		defer resp.Body.Close()
		scope := a.config.reasoningReplayScope(modelName)
		if stream {
			a.consumeStream(ctx, resp, yield, scope)
			return
		}
		out, err := a.parseSync(resp, scope)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(out, nil)
	}
}

// buildBody 把 genai 请求转换为 Responses 的 JSON 请求体。
func (a *responsesAdapter) buildBody(req *model.LLMRequest, tracker *callIDTracker, snap SettingsSnapshot, stream bool) (map[string]any, error) {
	req = expandToolImages(req, a.config.ImageInput)
	if a.config.APIKey == "" {
		return nil, errors.New("responses: API key is required")
	}
	modelName := a.config.modelName(req)
	if modelName == "" {
		return nil, errors.New("responses: model is required")
	}
	replayScope := a.config.reasoningReplayScope(modelName)
	input := make([]any, 0, len(req.Contents))
	for _, c := range req.Contents {
		if c == nil || len(c.Parts) == 0 {
			continue
		}
		switch c.Role {
		case genai.RoleUser:
			// ADK 把工具响应放在 user 角色的内容中。
			if hasFunctionResponse(c) {
				for _, p := range c.Parts {
					if p == nil || p.FunctionResponse == nil {
						continue
					}
					id := tracker.responseID(p.FunctionResponse)
					if id == "" {
						return nil, fmt.Errorf("tool response for %q has no call ID", p.FunctionResponse.Name)
					}
					input = append(input, map[string]any{
						"type": "function_call_output", "call_id": id,
						"output": toolResultText(p.FunctionResponse),
					})
				}
				continue
			}
			items, err := responsesUserItems(c)
			if err != nil {
				return nil, err
			}
			input = append(input, items...)
		case genai.RoleModel:
			for _, p := range c.Parts {
				if p == nil {
					continue
				}
				switch {
				case p.Text != "" && !p.Thought:
					item := map[string]any{
						"type": "message", "role": "assistant",
						"content": []any{map[string]any{"type": "output_text", "text": p.Text}},
					}
					if phase := reasoningReplay(p, replayScope, "phase"); phase != "" {
						item["phase"] = phase
					}
					input = append(input, item)
				case p.FunctionCall != nil:
					args, err := marshalToolArguments(p)
					if err != nil {
						return nil, fmt.Errorf("encode tool args for %s: %w", p.FunctionCall.Name, err)
					}
					input = append(input, map[string]any{
						"type": "function_call", "call_id": tracker.callID(p.FunctionCall),
						"name": p.FunctionCall.Name, "arguments": string(args),
					})
				case p.Thought:
					// 同作用域记录的加密推理条目按原文回传；
					// 无记录的旧思考保持既有行为被丢弃。
					if raw := reasoningReplay(p, replayScope, "item"); raw != "" && json.Valid([]byte(raw)) {
						input = append(input, json.RawMessage(raw))
					}
				}
			}
		default:
			for _, p := range c.Parts {
				if p == nil || p.FunctionResponse == nil {
					continue
				}
				id := tracker.responseID(p.FunctionResponse)
				if id == "" {
					return nil, fmt.Errorf("tool response for %q has no call ID", p.FunctionResponse.Name)
				}
				input = append(input, map[string]any{
					"type": "function_call_output", "call_id": id,
					"output": toolResultText(p.FunctionResponse),
				})
			}
		}
	}
	if len(input) == 0 {
		return nil, errors.New("responses: request has no input")
	}
	// store:false 不保留服务端会话，因此显式请求加密推理内容，
	// 让下一次请求可以无状态地回放。
	body := map[string]any{"model": modelName, "input": input, "stream": stream, "store": false, "include": []string{"reasoning.encrypted_content"}}
	if snap.ServiceTierFast {
		body["service_tier"] = "fast"
	}
	if system := systemText(req); system != "" {
		body["instructions"] = system
	}
	if tools := responsesTools(req); len(tools) > 0 {
		body["tools"] = tools
	}
	if maxTokens := a.config.effectiveMaxTokens(req, snap); maxTokens > 0 {
		body["max_output_tokens"] = maxTokens
	}
	if req != nil && req.Config != nil {
		if req.Config.Temperature != nil {
			body["temperature"] = *req.Config.Temperature
		}
		if req.Config.TopP != nil {
			body["top_p"] = *req.Config.TopP
		}
	}
	if effort := a.config.wireReasoningEffort(modelName, snap.ReasoningEffort); effort != "" {
		body["reasoning"] = map[string]any{"effort": effort}
	}
	return body, nil
}

// responsesUserItems 把用户内容渲染为 Responses 输入条目。
func responsesUserItems(c *genai.Content) ([]any, error) {
	var content []any
	for _, p := range c.Parts {
		if p == nil {
			continue
		}
		switch {
		case p.Text != "" && !p.Thought:
			content = append(content, map[string]any{"type": "input_text", "text": p.Text})
		case p.InlineData != nil:
			content = append(content, map[string]any{
				"type":      "input_image",
				"image_url": imageDataURL(p.InlineData.MIMEType, base64.StdEncoding.EncodeToString(p.InlineData.Data)),
			})
		case p.FileData != nil && p.FileData.FileURI != "":
			content = append(content, map[string]any{
				"type":      "input_image",
				"image_url": p.FileData.FileURI,
			})
		}
	}
	if len(content) == 0 {
		return nil, errors.New("responses: user message is empty")
	}
	return []any{map[string]any{"type": "message", "role": "user", "content": content}}, nil
}

// responsesTools 把工具声明转换为 Responses 工具。
func responsesTools(req *model.LLMRequest) []map[string]any {
	decls := functionDeclarations(req)
	if len(decls) == 0 {
		return nil
	}
	tools := make([]map[string]any, 0, len(decls))
	for _, d := range decls {
		if d == nil || d.Name == "" {
			continue
		}
		fn := map[string]any{"type": "function", "name": d.Name}
		if d.Description != "" {
			fn["description"] = d.Description
		}
		fn["parameters"] = functionParameters(d)
		tools = append(tools, fn)
	}
	if len(tools) == 0 {
		return nil
	}
	return tools
}

// responsesUsage 是 Responses 的用量块。
type responsesUsage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
	TotalTokens  int64 `json:"total_tokens"`
	InputDetails struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputDetails struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (u responsesUsage) toUsageMetadata() *genai.GenerateContentResponseUsageMetadata {
	total := u.TotalTokens
	if total == 0 {
		total = u.InputTokens + u.OutputTokens
	}
	return &genai.GenerateContentResponseUsageMetadata{
		PromptTokenCount:        int32(u.InputTokens),
		CandidatesTokenCount:    int32(u.OutputTokens),
		TotalTokenCount:         int32(total),
		CachedContentTokenCount: int32(u.InputDetails.CachedTokens),
		ThoughtsTokenCount:      int32(u.OutputDetails.ReasoningTokens),
	}
}

// responsesSummaryPart 是推理摘要中的一段文本。
type responsesSummaryPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// responsesSummary 兼容官方 Responses 的 summary 数组，以及部分网关返回的纯字符串。
// 推理条目在 output_item.added 时 summary 往往是 []，按 string 解码会直接中断整段流。
type responsesSummary []responsesSummaryPart

func (s *responsesSummary) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil
	}
	switch data[0] {
	case '"':
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		if text != "" {
			*s = responsesSummary{{Type: "summary_text", Text: text}}
		}
		return nil
	case '[':
		var parts []responsesSummaryPart
		if err := json.Unmarshal(data, &parts); err != nil {
			return err
		}
		*s = parts
		return nil
	default:
		return fmt.Errorf("responses summary: unsupported JSON")
	}
}

func (s responsesSummary) text() string {
	var b strings.Builder
	for _, part := range s {
		b.WriteString(part.Text)
	}
	return b.String()
}

// responsesOutputItem 是已完成响应中的一个条目。
type responsesOutputItem struct {
	Type    string           `json:"type"`
	ID      string           `json:"id"`
	CallID  string           `json:"call_id"`
	Name    string           `json:"name"`
	Status  string           `json:"status"`
	Summary responsesSummary `json:"summary"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Arguments        string `json:"arguments"`
	EncryptedContent string `json:"encrypted_content"`
	Phase            string `json:"phase"`
	// raw 保存可回放的推理条目原文；只有带加密内容的 reasoning
	// 条目才捕获，避免为普通条目保留无用副本。
	raw json.RawMessage
}

// UnmarshalJSON 在常规字段解码之外，为可回放的推理条目保留原始
// JSON；其它条目照常按类型解码。
func (item *responsesOutputItem) UnmarshalJSON(data []byte) error {
	type plain responsesOutputItem
	if err := json.Unmarshal(data, (*plain)(item)); err != nil {
		return err
	}
	item.raw = nil
	if item.Type == "reasoning" && item.EncryptedContent != "" {
		item.raw = bytes.Clone(data)
	}
	return nil
}

// parseSync 解码非流式的 Responses 调用。
func (a *responsesAdapter) parseSync(resp *http.Response, scope string) (*model.LLMResponse, error) {
	data, err := readBody(resp.Body)
	if err != nil {
		return nil, err
	}
	var wire struct {
		Output []responsesOutputItem `json:"output"`
		Usage  responsesUsage        `json:"usage"`
		Status string                `json:"status"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return nil, fmt.Errorf("decode responses body: %w", err)
	}
	if wire.Error != nil && wire.Error.Message != "" {
		return nil, fmt.Errorf("responses error: %s", wire.Error.Message)
	}
	parts, err := responsesParts(wire.Output, scope)
	if err != nil {
		return nil, err
	}
	return &model.LLMResponse{
		Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
		UsageMetadata: wire.Usage.toUsageMetadata(),
		TurnComplete:  true,
		FinishReason:  responsesFinishReason(wire.Status, wire.IncompleteDetails),
	}, nil
}

// responsesParts 根据输出条目组装最终模型内容。
func responsesParts(items []responsesOutputItem, scope string) ([]*genai.Part, error) {
	var parts []*genai.Part
	for _, item := range items {
		switch item.Type {
		case "message":
			for _, c := range item.Content {
				if c.Type == "output_text" && c.Text != "" {
					part := &genai.Part{Text: c.Text}
					if item.Phase == "commentary" || item.Phase == "final_answer" {
						setReasoningReplay(part, scope, "phase", item.Phase)
					}
					parts = append(parts, part)
				}
			}
		case "reasoning":
			text := reasoningText(item)
			// 只有加密内容的纯推理条目没有可见文本，仍保留
			// 一个空思考部分来承载续接状态。
			if text != "" || len(item.raw) > 0 {
				part := &genai.Part{Text: text, Thought: true}
				if len(item.raw) > 0 {
					setReasoningReplay(part, scope, "item", string(item.raw))
				}
				parts = append(parts, part)
			}
		case "function_call":
			if item.Name == "" {
				continue
			}
			id := item.CallID
			if id == "" {
				id = item.ID
			}
			parts = append(parts, toolCallPart("responses", item.Name, id, item.Arguments))
		}
	}
	return parts, nil
}

// reasoningText 取出推理条目里要展示的思考文本。
// 有完整 reasoning_text 时用它，否则退回 summary（数组或字符串）。
func reasoningText(item responsesOutputItem) string {
	var b strings.Builder
	for _, c := range item.Content {
		if c.Type == "reasoning_text" && c.Text != "" {
			b.WriteString(c.Text)
		}
	}
	if b.Len() > 0 {
		return b.String()
	}
	return item.Summary.text()
}

func responsesFinishReason(status string, incomplete *struct {
	Reason string `json:"reason"`
}) genai.FinishReason {
	if status == "incomplete" && incomplete != nil && incomplete.Reason == "max_output_tokens" {
		return genai.FinishReasonMaxTokens
	}
	return genai.FinishReasonStop
}

// consumeStream 读取 Responses 的 SSE 流。文本与推理摘要
// 增量作为部分结果产出；工具调用只在最终
// response.completed 事件中完成。
func (a *responsesAdapter) consumeStream(ctx context.Context, resp *http.Response, yield func(*model.LLMResponse, error) bool, scope string) {
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		out, err := a.parseSync(resp, scope)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(out, nil)
		return
	}
	type callAcc struct {
		callID string
		name   string
		args   strings.Builder
	}
	calls := map[string]*callAcc{}
	// response.completed 的 output 可能只有条目壳；加密推理
	// 的完整数据在 output_item.done 里送达，按 id 记住备用。
	doneReasoning := map[string]responsesOutputItem{}
	var text strings.Builder
	var usage responsesUsage
	var completed bool
	emit := func(part *genai.Part) bool {
		return yield(&model.LLMResponse{
			Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{part}},
			Partial: true,
		}, nil)
	}
	err := readSSE(ctx, resp.Body, func(ev sseEvent) error {
		var packet struct {
			Type     string               `json:"type"`
			Delta    string               `json:"delta"`
			Item     *responsesOutputItem `json:"item"`
			Response *struct {
				Usage  responsesUsage        `json:"usage"`
				Output []responsesOutputItem `json:"output"`
			} `json:"response"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if ev.Type == "" {
			if err := json.Unmarshal([]byte(ev.Data), &packet); err != nil {
				return fmt.Errorf("decode responses event: %w", err)
			}
		} else if err := json.Unmarshal([]byte(ev.Data), &packet); err != nil {
			return fmt.Errorf("decode responses event: %w", err)
		}
		switch packet.Type {
		case "response.output_text.delta":
			text.WriteString(packet.Delta)
			if !emit(&genai.Part{Text: packet.Delta}) {
				return errStopRead
			}
		case "response.reasoning_summary_text.delta":
			if !emit(&genai.Part{Text: packet.Delta, Thought: true}) {
				return errStopRead
			}
		case "response.output_item.added", "response.output_item.done":
			if packet.Item == nil {
				return nil
			}
			if packet.Type == "response.output_item.done" && packet.Item.Type == "reasoning" && packet.Item.ID != "" && len(packet.Item.raw) > 0 {
				doneReasoning[packet.Item.ID] = *packet.Item
			}
			if packet.Item.Type == "function_call" {
				id := packet.Item.CallID
				if id == "" {
					id = packet.Item.ID
				}
				acc := calls[id]
				if acc == nil {
					acc = &callAcc{callID: id}
					calls[id] = acc
				}
				if packet.Item.Name != "" {
					acc.name = packet.Item.Name
				}
			}
		case "response.function_call_arguments.delta":
			for _, acc := range calls {
				if acc.name != "" && acc.args.Len() == 0 {
					acc.args.WriteString(packet.Delta)
					break
				}
			}
		case "response.completed":
			if packet.Response != nil {
				usage = packet.Response.Usage
				if len(packet.Response.Output) > 0 {
					for i, item := range packet.Response.Output {
						if item.Type != "reasoning" || len(item.raw) > 0 || item.ID == "" {
							continue
						}
						done, ok := doneReasoning[item.ID]
						if !ok {
							continue
						}
						item.raw = done.raw
						item.EncryptedContent = done.EncryptedContent
						if reasoningText(item) == "" {
							item.Summary = done.Summary
							item.Content = done.Content
						}
						packet.Response.Output[i] = item
					}
					parts, err := responsesParts(packet.Response.Output, scope)
					if err != nil {
						return err
					}
					yield(&model.LLMResponse{
						Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
						UsageMetadata: usage.toUsageMetadata(),
						TurnComplete:  true,
						FinishReason:  genai.FinishReasonStop,
					}, nil)
				}
			}
			completed = true
			return errStopRead
		case "response.failed":
			reason := "unknown"
			if packet.Error != nil && packet.Error.Message != "" {
				reason = packet.Error.Message
			}
			return fmt.Errorf("responses stream failed: %s", reason)
		case "error":
			reason := "unknown"
			if packet.Error != nil && packet.Error.Message != "" {
				reason = packet.Error.Message
			}
			return fmt.Errorf("responses stream error: %s", reason)
		}
		return nil
	})
	if errors.Is(err, errStopRead) {
		err = nil
	}
	if err != nil {
		yield(nil, err)
		return
	}
	if err := ctx.Err(); err != nil {
		yield(nil, err)
		return
	}
	if !completed {
		yield(nil, errors.New("responses stream ended without completion event"))
		return
	}
}

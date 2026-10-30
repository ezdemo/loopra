package provider

import (
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
		resp, err := postJSON(ctx, a.config.Client, "POST", a.config.Endpoint, headers, body)
		logModelCall("responses", start, a.config.modelName(req), stream, err)
		if err != nil {
			yield(nil, err)
			return
		}
		defer resp.Body.Close()
		if stream {
			a.consumeStream(ctx, resp, yield)
			return
		}
		out, err := a.parseSync(resp)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(out, nil)
	}
}

// buildBody 把 genai 请求转换为 Responses 的 JSON 请求体。
func (a *responsesAdapter) buildBody(req *model.LLMRequest, tracker *callIDTracker, snap SettingsSnapshot, stream bool) (map[string]any, error) {
	if a.config.APIKey == "" {
		return nil, errors.New("responses: API key is required")
	}
	modelName := a.config.modelName(req)
	if modelName == "" {
		return nil, errors.New("responses: model is required")
	}
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
					input = append(input, map[string]any{
						"type": "message", "role": "assistant",
						"content": []any{map[string]any{"type": "output_text", "text": p.Text}},
					})
				case p.FunctionCall != nil:
					args, err := json.Marshal(p.FunctionCall.Args)
					if err != nil {
						return nil, fmt.Errorf("encode tool args for %s: %w", p.FunctionCall.Name, err)
					}
					input = append(input, map[string]any{
						"type": "function_call", "call_id": tracker.callID(p.FunctionCall),
						"name": p.FunctionCall.Name, "arguments": string(args),
					})
				case p.Thought:
					// 推理条目不会被重放（签名会被丢弃）。
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
	body := map[string]any{"model": modelName, "input": input, "stream": stream}
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
	if snap.ReasoningEffort != "" {
		effort := strings.ToLower(snap.ReasoningEffort)
		if effort == "max" {
			effort = "high"
		}
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
				"type": "input_image",
				"image_url": map[string]any{
					"url": imageDataURL(p.InlineData.MIMEType, base64.StdEncoding.EncodeToString(p.InlineData.Data)),
				},
			})
		case p.FileData != nil && p.FileData.FileURI != "":
			content = append(content, map[string]any{
				"type":      "input_image",
				"image_url": map[string]any{"url": p.FileData.FileURI},
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
		switch {
		case d.Parameters != nil:
			fn["parameters"] = schemaMap(d.Parameters)
		case d.ParametersJsonSchema != nil:
			if m, ok := jsonSchemaMap(d.ParametersJsonSchema); ok {
				fn["parameters"] = m
			} else {
				fn["parameters"] = emptyObjectSchema()
			}
		default:
			fn["parameters"] = emptyObjectSchema()
		}
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

// responsesOutputItem 是已完成响应中的一个条目。
type responsesOutputItem struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	CallID  string `json:"call_id"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Arguments string `json:"arguments"`
}

// parseSync 解码非流式的 Responses 调用。
func (a *responsesAdapter) parseSync(resp *http.Response) (*model.LLMResponse, error) {
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
	parts := responsesParts(wire.Output)
	return &model.LLMResponse{
		Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
		UsageMetadata: wire.Usage.toUsageMetadata(),
		TurnComplete:  true,
		FinishReason:  responsesFinishReason(wire.Status, wire.IncompleteDetails),
	}, nil
}

// responsesParts 根据输出条目组装最终模型内容。
func responsesParts(items []responsesOutputItem) []*genai.Part {
	var parts []*genai.Part
	for _, item := range items {
		switch item.Type {
		case "message":
			for _, c := range item.Content {
				if c.Type == "output_text" && c.Text != "" {
					parts = append(parts, &genai.Part{Text: c.Text})
				}
			}
		case "function_call":
			if item.Name == "" {
				continue
			}
			id := item.CallID
			if id == "" {
				id = item.ID
			}
			args := map[string]any{}
			if item.Arguments != "" {
				if err := json.Unmarshal([]byte(item.Arguments), &args); err != nil {
					args = map[string]any{"_raw": item.Arguments}
				}
			}
			parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{ID: id, Name: item.Name, Args: args}})
		}
	}
	return parts
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
func (a *responsesAdapter) consumeStream(ctx context.Context, resp *http.Response, yield func(*model.LLMResponse, error) bool) {
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		out, err := a.parseSync(resp)
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
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Item  *struct {
				responsesOutputItem
			} `json:"item"`
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
			if packet.Item != nil && packet.Item.Type == "function_call" {
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
					parts := responsesParts(packet.Response.Output)
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

package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"sort"
	"strings"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

// anthropicAdapter 基于 Anthropic Messages API 实现 model.LLM。
type anthropicAdapter struct {
	config Config
}

func (a *anthropicAdapter) Name() string { return a.config.DefaultModel }

func (a *anthropicAdapter) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		snap := a.config.Settings.Snapshot()
		headers, err := a.config.authAndExtraHeaders(snap)
		if err != nil {
			yield(nil, err)
			return
		}
		if stream {
			headers["Accept"] = "text/event-stream"
		}
		tracker := newCallIDTracker()
		body, err := a.buildBody(req, tracker, snap, stream)
		if err != nil {
			yield(nil, err)
			return
		}
		start := time.Now()
		resp, err := postJSON(ctx, a.config.Client, "POST", a.config.Endpoint, headers, body)
		logModelCall("anthropic", start, a.config.modelName(req), stream, err)
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

// buildBody 把 genai 请求转换为 Anthropic Messages 的 JSON 请求体。
func (a *anthropicAdapter) buildBody(req *model.LLMRequest, tracker *callIDTracker, snap SettingsSnapshot, stream bool) (map[string]any, error) {
	if a.config.APIKey == "" {
		return nil, errors.New("anthropic: API key is required")
	}
	modelName := a.config.modelName(req)
	if modelName == "" {
		return nil, errors.New("anthropic: model is required")
	}
	messages := make([]map[string]any, 0, len(req.Contents))
	lastTool := false
	appendToolResult := func(block map[string]any) {
		if lastTool {
			prev, _ := messages[len(messages)-1]["content"].([]any)
			messages[len(messages)-1]["content"] = append(prev, block)
		} else {
			messages = append(messages, map[string]any{"role": "user", "content": []any{block}})
		}
		lastTool = true
	}
	for _, c := range req.Contents {
		if c == nil || len(c.Parts) == 0 {
			continue
		}
		switch c.Role {
		case genai.RoleUser:
			if hasFunctionResponse(c) {
				for _, p := range c.Parts {
					if p == nil || p.FunctionResponse == nil {
						continue
					}
					id := tracker.responseID(p.FunctionResponse)
					if id == "" {
						return nil, fmt.Errorf("tool result for %q has no call ID", p.FunctionResponse.Name)
					}
					appendToolResult(map[string]any{
						"type": "tool_result", "tool_use_id": id,
						"content": toolResultText(p.FunctionResponse),
					})
				}
				continue
			}
			msg, err := anthropicUserMessage(c)
			if err != nil {
				return nil, err
			}
			messages = append(messages, msg)
			lastTool = false
		case genai.RoleModel:
			blocks := make([]any, 0, len(c.Parts))
			for _, p := range c.Parts {
				if p == nil {
					continue
				}
				switch {
				case p.Text != "" && p.Thought:
					// 为保持 extended thinking 的正确性，思考块会与 tool_use 一同重放
					// （签名会被丢弃，这是与 Java 实现共有的已知
					// 限制）。
					blocks = append(blocks, map[string]any{"type": "thinking", "thinking": p.Text})
				case p.Text != "":
					blocks = append(blocks, map[string]any{"type": "text", "text": p.Text})
				case p.FunctionCall != nil:
					input := p.FunctionCall.Args
					if input == nil {
						input = map[string]any{}
					}
					blocks = append(blocks, map[string]any{
						"type": "tool_use", "id": tracker.callID(p.FunctionCall),
						"name": p.FunctionCall.Name, "input": input,
					})
				}
			}
			if len(blocks) == 0 {
				continue
			}
			messages = append(messages, map[string]any{"role": "assistant", "content": blocks})
			lastTool = false
		default:
			// system/developer 内容由 systemText 收集。
		}
	}
	if len(messages) == 0 {
		return nil, errors.New("anthropic: request has no messages")
	}
	body := map[string]any{
		"model": modelName, "max_tokens": a.config.effectiveMaxTokens(req, snap),
		"messages": messages, "stream": stream,
	}
	if system := systemText(req); system != "" {
		body["system"] = system
	}
	if tools := anthropicTools(req); len(tools) > 0 {
		body["tools"] = tools
	}
	if req != nil && req.Config != nil {
		if req.Config.Temperature != nil {
			body["temperature"] = *req.Config.Temperature
		}
		if req.Config.TopP != nil {
			body["top_p"] = *req.Config.TopP
		}
	}
	return body, nil
}

// anthropicUserMessage 把用户内容渲染为 Messages 消息，
// 仅在存在图片时使用内容块。
func anthropicUserMessage(c *genai.Content) (map[string]any, error) {
	var texts []string
	var images []map[string]any
	for _, p := range c.Parts {
		if p == nil {
			continue
		}
		switch {
		case p.Text != "" && !p.Thought:
			texts = append(texts, p.Text)
		case p.InlineData != nil:
			images = append(images, map[string]any{
				"type": "image",
				"source": map[string]any{
					"type": "base64", "media_type": p.InlineData.MIMEType, "data": p.InlineData.Data,
				},
			})
		case p.FileData != nil && p.FileData.FileURI != "":
			images = append(images, map[string]any{
				"type":   "image",
				"source": map[string]any{"type": "url", "url": p.FileData.FileURI},
			})
		}
	}
	if len(images) == 0 {
		if len(texts) == 0 {
			return nil, errors.New("anthropic: user message is empty")
		}
		return map[string]any{"role": "user", "content": strings.Join(texts, "\n")}, nil
	}
	content := make([]any, 0, len(texts)+len(images))
	for _, t := range texts {
		content = append(content, map[string]any{"type": "text", "text": t})
	}
	for _, img := range images {
		content = append(content, img)
	}
	return map[string]any{"role": "user", "content": content}, nil
}

// anthropicTools 把工具声明转换为 Messages 工具。
func anthropicTools(req *model.LLMRequest) []map[string]any {
	decls := functionDeclarations(req)
	if len(decls) == 0 {
		return nil
	}
	tools := make([]map[string]any, 0, len(decls))
	for _, d := range decls {
		if d == nil || d.Name == "" {
			continue
		}
		fn := map[string]any{"name": d.Name}
		if d.Description != "" {
			fn["description"] = d.Description
		}
		switch {
		case d.Parameters != nil:
			fn["input_schema"] = schemaMap(d.Parameters)
		case d.ParametersJsonSchema != nil:
			if m, ok := jsonSchemaMap(d.ParametersJsonSchema); ok {
				fn["input_schema"] = m
			} else {
				fn["input_schema"] = emptyObjectSchema()
			}
		default:
			fn["input_schema"] = emptyObjectSchema()
		}
		tools = append(tools, fn)
	}
	if len(tools) == 0 {
		return nil
	}
	return tools
}

// anthropicUsage 是 Messages 的用量块。
type anthropicUsage struct {
	Input      int64 `json:"input_tokens"`
	Output     int64 `json:"output_tokens"`
	CacheRead  int64 `json:"cache_read_input_tokens"`
	CacheWrite int64 `json:"cache_creation_input_tokens"`
}

func (u anthropicUsage) toUsageMetadata() *genai.GenerateContentResponseUsageMetadata {
	prompt := u.Input + u.CacheRead + u.CacheWrite
	return &genai.GenerateContentResponseUsageMetadata{
		PromptTokenCount:        int32(prompt),
		CandidatesTokenCount:    int32(u.Output),
		TotalTokenCount:         int32(prompt + u.Output),
		CachedContentTokenCount: int32(u.CacheRead),
	}
}

// anthropicContentBlock 是 Messages 响应中的一个块。
type anthropicContentBlock struct {
	Type     string         `json:"type"`
	Text     string         `json:"text"`
	Thinking string         `json:"thinking"`
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Input    map[string]any `json:"input"`
}

// parseSync 解码非流式的 Messages 调用。
func (a *anthropicAdapter) parseSync(resp *http.Response) (*model.LLMResponse, error) {
	data, err := readBody(resp.Body)
	if err != nil {
		return nil, err
	}
	var wire struct {
		Role       string                  `json:"role"`
		Content    []anthropicContentBlock `json:"content"`
		Usage      anthropicUsage          `json:"usage"`
		StopReason string                  `json:"stop_reason"`
		Error      *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return nil, fmt.Errorf("decode anthropic response: %w", err)
	}
	if wire.Error != nil && wire.Error.Message != "" {
		return nil, fmt.Errorf("anthropic error: %s", wire.Error.Message)
	}
	if wire.Role != "" && wire.Role != "assistant" {
		return nil, fmt.Errorf("unexpected anthropic role %q", wire.Role)
	}
	parts, err := anthropicParts(wire.Content)
	if err != nil {
		return nil, err
	}
	meta := map[string]any{}
	if wire.Usage.CacheWrite > 0 {
		meta["cacheCreationTokens"] = wire.Usage.CacheWrite
	}
	return &model.LLMResponse{
		Content:        &genai.Content{Role: genai.RoleModel, Parts: parts},
		UsageMetadata:  wire.Usage.toUsageMetadata(),
		CustomMetadata: meta,
		TurnComplete:   true,
		FinishReason:   anthropicFinishReason(wire.StopReason),
	}, nil
}

// anthropicParts 把内容块转换为 genai parts。
func anthropicParts(blocks []anthropicContentBlock) ([]*genai.Part, error) {
	var parts []*genai.Part
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				parts = append(parts, &genai.Part{Text: b.Text})
			}
		case "thinking":
			if b.Thinking != "" {
				parts = append(parts, &genai.Part{Text: b.Thinking, Thought: true})
			}
		case "tool_use":
			if b.ID == "" || b.Name == "" {
				return nil, errors.New("tool_use block lacks ID or name")
			}
			input := b.Input
			if input == nil {
				input = map[string]any{}
			}
			parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{ID: b.ID, Name: b.Name, Args: input}})
		}
	}
	return parts, nil
}

func anthropicFinishReason(reason string) genai.FinishReason {
	switch reason {
	case "max_tokens":
		return genai.FinishReasonMaxTokens
	case "stop_sequence", "end_turn":
		return genai.FinishReasonStop
	case "refusal":
		return genai.FinishReasonOther
	case "":
		return genai.FinishReasonStop
	default:
		return genai.FinishReasonOther
	}
}

// consumeStream 读取 Messages 的 SSE 流，产出文本与思考增量，
// 以及一个最终组装完成的响应。
func (a *anthropicAdapter) consumeStream(ctx context.Context, resp *http.Response, yield func(*model.LLMResponse, error) bool) {
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		out, err := a.parseSync(resp)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(out, nil)
		return
	}
	type blockAcc struct {
		id      string
		name    string
		initial map[string]any
		args    strings.Builder
	}
	blocks := map[int]*blockAcc{}
	var text, thinking strings.Builder
	var usage anthropicUsage
	finished := false
	emit := func(part *genai.Part) bool {
		return yield(&model.LLMResponse{
			Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{part}},
			Partial: true,
		}, nil)
	}
	err := readSSE(ctx, resp.Body, func(ev sseEvent) error {
		var packet struct {
			Type         string                         `json:"type"`
			Index        int                            `json:"index"`
			Message      struct{ Usage anthropicUsage } `json:"message"`
			ContentBlock anthropicContentBlock          `json:"content_block"`
			Delta        struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Thinking string `json:"thinking"`
				Partial  string `json:"partial_json"`
			} `json:"delta"`
			Usage *struct {
				Output int64 `json:"output_tokens"`
			} `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(ev.Data), &packet); err != nil {
			return fmt.Errorf("decode anthropic SSE: %w", err)
		}
		switch packet.Type {
		case "message_start":
			usage = packet.Message.Usage
		case "content_block_start":
			switch packet.ContentBlock.Type {
			case "tool_use":
				blocks[packet.Index] = &blockAcc{id: packet.ContentBlock.ID, name: packet.ContentBlock.Name, initial: packet.ContentBlock.Input}
			case "text":
				if packet.ContentBlock.Text != "" {
					text.WriteString(packet.ContentBlock.Text)
					if !emit(&genai.Part{Text: packet.ContentBlock.Text}) {
						return errStopRead
					}
				}
			}
		case "content_block_delta":
			switch packet.Delta.Type {
			case "text_delta":
				text.WriteString(packet.Delta.Text)
				if !emit(&genai.Part{Text: packet.Delta.Text}) {
					return errStopRead
				}
			case "thinking_delta":
				thinking.WriteString(packet.Delta.Thinking)
				if !emit(&genai.Part{Text: packet.Delta.Thinking, Thought: true}) {
					return errStopRead
				}
			case "input_json_delta":
				acc := blocks[packet.Index]
				if acc == nil {
					return errors.New("input_json_delta before tool_use")
				}
				acc.args.WriteString(packet.Delta.Partial)
			}
		case "message_delta":
			if packet.Usage != nil {
				usage.Output = packet.Usage.Output
			}
		case "message_stop":
			finished = true
			return errStopRead
		case "error":
			reason := "unknown"
			if packet.Error != nil {
				reason = packet.Error.Message
			}
			return fmt.Errorf("anthropic SSE error: %s", reason)
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
	if !finished {
		yield(nil, errors.New("anthropic stream ended without message_stop"))
		return
	}
	var assembled []anthropicContentBlock
	if thinking.Len() > 0 {
		assembled = append(assembled, anthropicContentBlock{Type: "thinking", Thinking: thinking.String()})
	}
	if text.Len() > 0 {
		assembled = append(assembled, anthropicContentBlock{Type: "text", Text: text.String()})
	}
	idx := make([]int, 0, len(blocks))
	for i := range blocks {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		b := blocks[i]
		if b.id == "" || b.name == "" {
			yield(nil, errors.New("anthropic stream produced an incomplete tool_use"))
			return
		}
		input := b.initial
		if b.args.Len() > 0 {
			if err := json.Unmarshal([]byte(b.args.String()), &input); err != nil {
				yield(nil, fmt.Errorf("anthropic tool %s JSON: %w", b.name, err))
				return
			}
		}
		if input == nil {
			input = map[string]any{}
		}
		assembled = append(assembled, anthropicContentBlock{Type: "tool_use", ID: b.id, Name: b.name, Input: input})
	}
	parts, err := anthropicParts(assembled)
	if err != nil {
		yield(nil, err)
		return
	}
	meta := map[string]any{}
	if usage.CacheWrite > 0 {
		meta["cacheCreationTokens"] = usage.CacheWrite
	}
	yield(&model.LLMResponse{
		Content:        &genai.Content{Role: genai.RoleModel, Parts: parts},
		UsageMetadata:  usage.toUsageMetadata(),
		CustomMetadata: meta,
		TurnComplete:   true,
		FinishReason:   genai.FinishReasonStop,
	}, nil)
}

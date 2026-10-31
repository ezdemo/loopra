package provider

import (
	"context"
	"encoding/base64"
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

// chatAdapter 基于 OpenAI 兼容的 Chat Completions 协议
// 实现 model.LLM（同样适用于 DeepSeek 等兼容网关）。
type chatAdapter struct {
	config Config
}

func (a *chatAdapter) Name() string { return a.config.DefaultModel }

func (a *chatAdapter) Protocol() string { return ProtocolChatCompletions }

func (a *chatAdapter) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
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
		resp, err := postJSON(withRequestObserver(ctx, req), a.config.Client, "POST", a.config.Endpoint, headers, body)
		logModelCall("chat_completions", start, a.config.modelName(req), stream, err)
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

// wireChatMessage 是一条 Chat Completions 消息。
type wireChatMessage struct {
	Role             string         `json:"role"`
	Content          any            `json:"content,omitempty"`
	ToolCallID       string         `json:"tool_call_id,omitempty"`
	ToolCalls        []wireChatCall `json:"tool_calls,omitempty"`
	ReasoningContent string         `json:"reasoning_content,omitempty"`
}

type wireChatCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// wireChatCallDelta 是流式响应中的一个 tool_call 分片。与完整消息不同，
// 它带 index 以区分同一条消息内的多个并行调用；缺少该字段会让所有分片
// 落进同一个累加器，把多个调用的 JSON 参数拼成非法内容。
type wireChatCallDelta struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// wireChatDelta 是一条流式补全增量。Thinking 有两种线上字段：
// 官方风格用 reasoning_content，OpenRouter 等网关用 reasoning；
// 只认前者会让这些网关的思考全部丢失。
type wireChatDelta struct {
	Content          string              `json:"content"`
	ReasoningContent string              `json:"reasoning_content"`
	Reasoning        string              `json:"reasoning"`
	ToolCalls        []wireChatCallDelta `json:"tool_calls"`
}

// reasoningText 返回该增量携带的思考文本，优先取值更明确的
// reasoning_content，回退到 reasoning。
func (d wireChatDelta) reasoningText() string {
	if d.ReasoningContent != "" {
		return d.ReasoningContent
	}
	return d.Reasoning
}

// buildBody 把 genai 请求转换为 Chat Completions 的 JSON 请求体。
func (a *chatAdapter) buildBody(req *model.LLMRequest, tracker *callIDTracker, snap SettingsSnapshot, stream bool) (map[string]any, error) {
	if a.config.APIKey == "" {
		return nil, errors.New("chat completions: API key is required")
	}
	modelName := a.config.modelName(req)
	if modelName == "" {
		return nil, errors.New("chat completions: model is required")
	}
	messages := make([]wireChatMessage, 0, len(req.Contents)+1)
	if system := systemText(req); system != "" {
		messages = append(messages, wireChatMessage{Role: "system", Content: system})
	}
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
					messages = append(messages, wireChatMessage{Role: "tool", ToolCallID: id, Content: toolResultText(p.FunctionResponse)})
				}
				continue
			}
			msg, err := chatUserMessage(c)
			if err != nil {
				return nil, err
			}
			messages = append(messages, *msg)
		case genai.RoleModel:
			msg := wireChatMessage{Role: "assistant"}
			var texts []string
			for _, p := range c.Parts {
				if p == nil {
					continue
				}
				switch {
				case p.Text != "" && !p.Thought:
					texts = append(texts, p.Text)
				case p.FunctionCall != nil:
					args, err := json.Marshal(p.FunctionCall.Args)
					if err != nil {
						return nil, fmt.Errorf("encode tool args for %s: %w", p.FunctionCall.Name, err)
					}
					call := wireChatCall{ID: tracker.callID(p.FunctionCall), Type: "function"}
					call.Function.Name = p.FunctionCall.Name
					call.Function.Arguments = string(args)
					msg.ToolCalls = append(msg.ToolCalls, call)
				case p.Thought:
					// 在 Chat Completions 中不会重放推理内容。
				}
			}
			if len(texts) > 0 {
				msg.Content = strings.Join(texts, "\n")
			}
			if msg.Content == nil && len(msg.ToolCalls) == 0 {
				continue
			}
			messages = append(messages, msg)
		default:
			// 工具响应以 user 角色的内容到达。
			if !hasFunctionResponse(c) {
				continue
			}
			for _, p := range c.Parts {
				if p == nil || p.FunctionResponse == nil {
					continue
				}
				id := tracker.responseID(p.FunctionResponse)
				if id == "" {
					return nil, fmt.Errorf("tool response for %q has no call ID", p.FunctionResponse.Name)
				}
				messages = append(messages, wireChatMessage{Role: "tool", ToolCallID: id, Content: toolResultText(p.FunctionResponse)})
			}
		}
	}
	if len(messages) == 0 {
		return nil, errors.New("chat completions: request has no messages")
	}
	body := map[string]any{"model": modelName, "messages": messages, "stream": stream}
	if snap.ServiceTierFast {
		body["service_tier"] = "fast"
	}
	if stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if tools := chatTools(req); len(tools) > 0 {
		body["tools"] = tools
	}
	maxTokens := a.config.effectiveMaxTokens(req, snap)
	if maxTokens > 0 {
		body["max_tokens"] = maxTokens
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
		body["reasoning_effort"] = strings.ToLower(snap.ReasoningEffort)
	}
	return body, nil
}

// chatUserMessage 渲染用户内容，仅在存在图片时使用
// 富内容数组。
func chatUserMessage(c *genai.Content) (*wireChatMessage, error) {
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
				"type":      "image_url",
				"image_url": map[string]any{"url": imageDataURL(p.InlineData.MIMEType, base64.StdEncoding.EncodeToString(p.InlineData.Data))},
			})
		case p.FileData != nil && p.FileData.FileURI != "":
			images = append(images, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": p.FileData.FileURI},
			})
		}
	}
	if len(images) == 0 {
		if len(texts) == 0 {
			return nil, errors.New("chat completions: user message is empty")
		}
		return &wireChatMessage{Role: genai.RoleUser, Content: strings.Join(texts, "\n")}, nil
	}
	content := make([]any, 0, len(texts)+len(images))
	for _, t := range texts {
		content = append(content, map[string]any{"type": "text", "text": t})
	}
	for _, img := range images {
		content = append(content, img)
	}
	return &wireChatMessage{Role: genai.RoleUser, Content: content}, nil
}

func imageDataURL(mime, b64 string) string {
	if mime == "" {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + b64
}

func hasFunctionResponse(c *genai.Content) bool {
	for _, p := range c.Parts {
		if p != nil && p.FunctionResponse != nil {
			return true
		}
	}
	return false
}

// chatTools 把工具声明转换为 Chat Completions 工具。
func chatTools(req *model.LLMRequest) []map[string]any {
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
		tools = append(tools, map[string]any{"type": "function", "function": fn})
	}
	if len(tools) == 0 {
		return nil
	}
	return tools
}

// chatUsage 是 Chat Completions 的用量块。
type chatUsage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	PromptDetails    struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionDetails struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func (u chatUsage) toUsageMetadata() *genai.GenerateContentResponseUsageMetadata {
	return &genai.GenerateContentResponseUsageMetadata{
		PromptTokenCount:        int32(u.PromptTokens),
		CandidatesTokenCount:    int32(u.CompletionTokens),
		TotalTokenCount:         int32(u.PromptTokens + u.CompletionTokens),
		CachedContentTokenCount: int32(u.PromptDetails.CachedTokens),
		ThoughtsTokenCount:      int32(u.CompletionDetails.ReasoningTokens),
	}
}

// parseSync 解码非流式补全响应。
func (a *chatAdapter) parseSync(resp *http.Response) (*model.LLMResponse, error) {
	data, err := readBody(resp.Body)
	if err != nil {
		return nil, err
	}
	var wire struct {
		Choices []struct {
			Message struct {
				Role             string          `json:"role"`
				Content          json.RawMessage `json:"content"`
				ReasoningContent string          `json:"reasoning_content"`
				Reasoning        string          `json:"reasoning"`
				ToolCalls        []wireChatCall  `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage chatUsage `json:"usage"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return nil, fmt.Errorf("decode chat response: %w", err)
	}
	if len(wire.Choices) == 0 {
		return nil, errors.New("chat response had no choices")
	}
	choice := wire.Choices[0]
	if choice.Message.Role != "" && choice.Message.Role != "assistant" {
		return nil, fmt.Errorf("unexpected completion role %q", choice.Message.Role)
	}
	reasoning := choice.Message.ReasoningContent
	if reasoning == "" {
		reasoning = choice.Message.Reasoning
	}
	parts := chatParts(choice.Message.Content, reasoning, choice.Message.ToolCalls)
	return &model.LLMResponse{
		Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
		UsageMetadata: wire.Usage.toUsageMetadata(),
		TurnComplete:  true,
		FinishReason:  chatFinishReason(choice.FinishReason),
	}, nil
}

// chatParts 根据补全消息组装最终模型内容。
func chatParts(rawContent json.RawMessage, reasoning string, calls []wireChatCall) []*genai.Part {
	var parts []*genai.Part
	if reasoning != "" {
		parts = append(parts, &genai.Part{Text: reasoning, Thought: true})
	}
	if len(rawContent) > 0 && string(rawContent) != "null" {
		var text any
		if err := json.Unmarshal(rawContent, &text); err == nil {
			switch v := text.(type) {
			case string:
				if v != "" {
					parts = append(parts, &genai.Part{Text: v})
				}
			}
		}
	}
	for _, c := range calls {
		if c.ID == "" || c.Function.Name == "" {
			continue
		}
		args := map[string]any{}
		if c.Function.Arguments != "" {
			if err := json.Unmarshal([]byte(c.Function.Arguments), &args); err != nil {
				args = map[string]any{"_raw": c.Function.Arguments}
			}
		}
		parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{ID: c.ID, Name: c.Function.Name, Args: args}})
	}
	return parts
}

func chatFinishReason(reason string) genai.FinishReason {
	switch strings.ToLower(reason) {
	case "stop":
		return genai.FinishReasonStop
	case "length":
		return genai.FinishReasonMaxTokens
	case "content_filter":
		return genai.FinishReasonSafety
	case "":
		return genai.FinishReasonStop
	default:
		return genai.FinishReasonOther
	}
}

// consumeStream 读取 SSE 流，产出文本与推理的部分增量，
// 以及一个最终组装完成的响应。工具调用只出现在最终
// 响应中，因为该协议没有针对单个调用的完成事件。
func (a *chatAdapter) consumeStream(ctx context.Context, resp *http.Response, yield func(*model.LLMResponse, error) bool) {
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		out, err := a.parseSync(resp)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(out, nil)
		return
	}
	type toolAcc struct {
		id   string
		name string
		args strings.Builder
	}
	tools := map[int]*toolAcc{}
	// route 把协议里的 index 映射到实际槽位。多数网关的 index 递增，
	// 但部分网关对所有分片都发 index=0，只能靠新出现的调用 id 拆开。
	route := map[int]int{}
	nextSlot := 0
	var text, reasoning strings.Builder
	var usage chatUsage
	var finishReason string
	done := false
	emit := func(part *genai.Part) bool {
		return yield(&model.LLMResponse{
			Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{part}},
			Partial: true,
		}, nil)
	}
	err := readSSE(ctx, resp.Body, func(ev sseEvent) error {
		if ev.Data == "[DONE]" {
			done = true
			return errStopRead
		}
		var packet struct {
			Choices []struct {
				Delta        wireChatDelta `json:"delta"`
				FinishReason string        `json:"finish_reason"`
			} `json:"choices"`
			Usage *chatUsage `json:"usage"`
		}
		if err := json.Unmarshal([]byte(ev.Data), &packet); err != nil {
			return fmt.Errorf("decode chat chunk: %w", err)
		}
		if packet.Usage != nil {
			usage = *packet.Usage
		}
		if len(packet.Choices) == 0 {
			return nil
		}
		choice := packet.Choices[0]
		if choice.FinishReason != "" {
			finishReason = choice.FinishReason
		}
		if choice.Delta.Content != "" {
			text.WriteString(choice.Delta.Content)
			if !emit(&genai.Part{Text: choice.Delta.Content}) {
				return errStopRead
			}
		}
		if thought := choice.Delta.reasoningText(); thought != "" {
			reasoning.WriteString(thought)
			if !emit(&genai.Part{Text: thought, Thought: true}) {
				return errStopRead
			}
		}
		for _, c := range choice.Delta.ToolCalls {
			slot, ok := route[c.Index]
			if !ok {
				slot = nextSlot
				nextSlot++
				route[c.Index] = slot
				tools[slot] = &toolAcc{}
			}
			acc := tools[slot]
			if c.ID != "" && acc.id != "" && acc.id != c.ID {
				// 同一 index 上出现新的调用 id：网关没有给出递增 index，
				// 另开一个槽位，避免把两次调用的参数串在一起。
				slot = nextSlot
				nextSlot++
				route[c.Index] = slot
				acc = &toolAcc{}
				tools[slot] = acc
			}
			if c.ID != "" {
				acc.id = c.ID
			}
			if c.Function.Name != "" {
				acc.name = c.Function.Name
			}
			acc.args.WriteString(c.Function.Arguments)
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
	if !done {
		yield(nil, errors.New("chat stream ended without [DONE]"))
		return
	}
	var calls []wireChatCall
	idx := make([]int, 0, len(tools))
	for i := range tools {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		t := tools[i]
		if t.id == "" || t.name == "" {
			yield(nil, errors.New("chat stream produced an incomplete tool call"))
			return
		}
		call := wireChatCall{ID: t.id, Type: "function"}
		call.Function.Name = t.name
		call.Function.Arguments = t.args.String()
		calls = append(calls, call)
	}
	rawContent := json.RawMessage(nil)
	if text.Len() > 0 {
		raw, _ := json.Marshal(text.String())
		rawContent = raw
	}
	parts := chatParts(rawContent, reasoning.String(), calls)
	yield(&model.LLMResponse{
		Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
		UsageMetadata: usage.toUsageMetadata(),
		TurnComplete:  true,
		FinishReason:  chatFinishReason(finishReason),
	}, nil)
}

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/plugin"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/provider"
	svcplugin "github.com/ezdemo/looprax/internal/service/plugin"
)

const (
	decisionAllow = "allow"
	decisionDeny  = "deny"
	decisionAsk   = "ask"
)

type parentSessionKey struct{}

// WithParentSession 让子代理这一轮的钩子能读到父会话。
func WithParentSession(ctx context.Context, id string) context.Context {
	if ctx == nil || id == "" {
		return ctx
	}
	return context.WithValue(ctx, parentSessionKey{}, id)
}

func parentSessionOf(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(parentSessionKey{}).(string)
	return id
}

// RuntimePlugins 是每个 runner 都要安装的插件。钩子在工具完成通知之前，
// 这样改写后的结果才会被上报；钩子若换成一份全新的结果，会自己再通知一次。
func RuntimePlugins(m model.LLM) ([]*plugin.Plugin, error) {
	hooks, err := HooksPlugin(modelProtocol(m))
	if err != nil {
		return nil, err
	}
	notifier, err := ToolResultPlugin()
	if err != nil {
		return nil, err
	}
	return []*plugin.Plugin{hooks, notifier}, nil
}

func modelProtocol(m model.LLM) string {
	type protocolNamer interface{ Protocol() string }
	if namer, ok := m.(protocolNamer); ok && namer != nil {
		return namer.Protocol()
	}
	return ""
}

// HooksPlugin 把已安装的 moejs 插件接到这一轮的 ADK 回调上。
// protocol 是这个模型适配器的协议名，写进 llmRequest。宿主还没就绪时回调什么都不做。
func HooksPlugin(protocol string) (*plugin.Plugin, error) {
	bridge := &hookBridge{protocol: protocol}
	return plugin.New(plugin.Config{
		Name:                  "loopra-plugin-hooks",
		OnUserMessageCallback: bridge.onUserMessage,
		BeforeRunCallback:     bridge.beforeRun,
		AfterRunCallback:      bridge.afterRun,
		OnEventCallback:       bridge.onEvent,
		BeforeModelCallback:   bridge.beforeModel,
		AfterModelCallback:    bridge.afterModel,
		OnModelErrorCallback:  bridge.onModelError,
		BeforeToolCallback:    bridge.beforeTool,
		AfterToolCallback:     bridge.afterTool,
	})
}

type turnNote struct {
	cancel bool
	reason string
	status string
}

type hookBridge struct {
	protocol string
	turns    sync.Map
	wires    sync.Map
}

func (h *hookBridge) onUserMessage(ctx agent.InvocationContext, msg *genai.Content) (*genai.Content, error) {
	host := svcplugin.Active()
	if host == nil || ctx == nil {
		return nil, nil
	}
	original := plainText(msg)
	input := invocationBase(ctx)
	input["message"] = original
	out, touched := host.RunHook(ctx, svcplugin.HookTurnBefore, input, func(got map[string]any) bool {
		cancel, _ := got["cancel"].(bool)
		return cancel
	})
	if touched["cancel"] {
		if cancel, _ := out["cancel"].(bool); cancel {
			reason, _ := out["reason"].(string)
			h.turns.Store(ctx.InvocationID(), &turnNote{cancel: true, reason: reason})
		}
	}
	text := original
	changed := false
	if touched["message"] {
		if next, ok := out["message"].(string); ok && next != original {
			text = next
			changed = true
		}
	}
	if touched["context"] {
		if extra, ok := out["context"].(string); ok && extra != "" {
			if text != "" {
				text += "\n\n"
			}
			text += extra
			changed = true
		}
	}
	if !changed {
		return nil, nil
	}
	return rewriteUserContent(msg, text), nil
}

func (h *hookBridge) beforeRun(ctx agent.InvocationContext) (*genai.Content, error) {
	if ctx == nil {
		return nil, nil
	}
	value, ok := h.turns.Load(ctx.InvocationID())
	if !ok {
		return nil, nil
	}
	note, _ := value.(*turnNote)
	if note == nil || !note.cancel {
		return nil, nil
	}
	reason := note.reason
	if reason == "" {
		reason = "这一轮已取消"
	}
	return &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: reason}}}, nil
}

func (h *hookBridge) afterRun(ctx agent.InvocationContext) {
	if ctx == nil {
		return
	}
	id := ctx.InvocationID()
	h.releaseWire(id)
	var note *turnNote
	if value, ok := h.turns.LoadAndDelete(id); ok {
		note, _ = value.(*turnNote)
	}
	host := svcplugin.Active()
	if host == nil {
		return
	}
	status := "completed"
	reason := ""
	if note != nil {
		reason = note.reason
		if note.cancel {
			status = "cancelled"
		}
		if note.status == "error" {
			status = "error"
		}
	}
	if status == "completed" && ctx.Err() != nil {
		status = "cancelled"
		if reason == "" {
			reason = ctx.Err().Error()
		}
	}
	input := invocationBase(ctx)
	input["status"] = status
	if reason != "" {
		input["reason"] = reason
	}
	host.RunHook(ctx, svcplugin.HookTurnAfter, input, nil)
}

func (h *hookBridge) onEvent(ctx agent.InvocationContext, event *session.Event) (*session.Event, error) {
	if event == nil || event.Actions.Compaction == nil || event.Actions.Compaction.CompactedContent == nil {
		return nil, nil
	}
	host := svcplugin.Active()
	if host == nil {
		return nil, nil
	}
	content := event.Actions.Compaction.CompactedContent
	input := invocationBase(ctx)
	input["summary"] = plainText(content)
	out, touched := host.RunHook(ctx, svcplugin.HookCompact, input, nil)
	if applyCompact(content, out, touched) {
		return nil, errors.New("插件丢弃了这次上下文压缩")
	}
	return nil, nil
}

func (h *hookBridge) beforeModel(ctx agent.Context, req *model.LLMRequest) (*model.LLMResponse, error) {
	if ctx != nil && req != nil {
		defer h.rememberWire(ctx.InvocationID(), req)
	}
	host := svcplugin.Active()
	if host == nil || req == nil {
		return nil, nil
	}
	h.rewriteSystem(ctx, host, req)
	h.rewriteRequest(ctx, host, req)
	if host.HasHook(svcplugin.HookLLMRequestSent) {
		base := callbackBase(ctx)
		base["protocol"], base["model"] = h.protocol, req.Model
		ids := []string{}
		for _, content := range req.Contents {
			if content == nil {
				continue
			}
			for _, part := range content.Parts {
				if part != nil && part.FunctionResponse != nil && part.FunctionResponse.ID != "" {
					ids = append(ids, part.FunctionResponse.ID)
				}
			}
		}
		base["foldableCalls"] = ids
		provider.SetRequestObserver(req, func(raw string) {
			var body map[string]any
			if json.Unmarshal([]byte(raw), &body) != nil {
				return
			}
			input := make(map[string]any, len(base)+1)
			for key, value := range base {
				input[key] = value
			}
			input["body"] = body
			input["requestBytes"] = len(raw)
			// Observer return values are deliberately ignored.
			host.RunObserver(ctx, svcplugin.HookLLMRequestSent, input)
		})
	}
	return nil, nil
}

func (h *hookBridge) afterModel(ctx agent.Context, resp *model.LLMResponse, _ error) (*model.LLMResponse, error) {
	if resp == nil || resp.Partial {
		return nil, nil
	}
	host := svcplugin.Active()
	if host == nil {
		return nil, nil
	}
	text, thought, calls := splitResponse(resp.Content)
	input := callbackBase(ctx)
	input["text"] = text
	input["thought"] = thought
	input["toolCalls"] = calls
	if resp.ErrorMessage != "" {
		input["error"] = resp.ErrorMessage
	}
	out, touched := host.RunHook(ctx, svcplugin.HookLLMResponse, input, nil)
	applyModelResponse(resp, out, touched)
	return nil, nil
}

func (h *hookBridge) onModelError(ctx agent.Context, req *model.LLMRequest, err error) (*model.LLMResponse, error) {
	if req != nil {
		provider.TakeWireBody(req)
	}
	if ctx == nil || err == nil {
		return nil, nil
	}
	reason := err.Error()
	id := ctx.InvocationID()
	if value, ok := h.turns.Load(id); ok {
		if note, _ := value.(*turnNote); note != nil {
			note.status = "error"
			note.reason = reason
			return nil, nil
		}
	}
	h.turns.Store(id, &turnNote{status: "error", reason: reason})
	return nil, nil
}

func (h *hookBridge) beforeTool(ctx agent.Context, t tool.Tool, args map[string]any) (map[string]any, error) {
	if ctx == nil || t == nil || t.Name() == toolconfirmation.FunctionCallName {
		return nil, nil
	}
	host := svcplugin.Active()
	if host == nil {
		return nil, nil
	}
	approved := false
	if confirmation := ctx.ToolConfirmation(); confirmation != nil && confirmation.Confirmed {
		approved = true
	}
	input := callbackBase(ctx)
	input["name"] = t.Name()
	input["id"] = ctx.FunctionCallID()
	input["args"] = cloneMap(args)
	input["approved"] = approved
	out, touched := host.RunHook(ctx, svcplugin.HookToolBefore, input, func(got map[string]any) bool {
		decision, _ := got["decision"].(string)
		return decision == decisionDeny || decision == decisionAsk
	})
	if touched["args"] && args != nil {
		if next, ok := out["args"].(map[string]any); ok {
			replaceMap(args, next)
		}
	}
	decision, _ := out["decision"].(string)
	reason, _ := out["reason"].(string)
	switch decision {
	case decisionDeny:
		if reason == "" {
			reason = "插件拒绝了这次工具调用"
		}
		return map[string]any{"error": reason}, nil
	case decisionAsk:
		if approved {
			return nil, nil
		}
		if reason == "" {
			reason = "插件要求确认这次工具调用"
		}
		if err := ctx.RequestConfirmation(reason, cloneMap(args)); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("error tool %q %w", t.Name(), tool.ErrConfirmationRequired)
	default:
		return nil, nil
	}
}

func (h *hookBridge) afterTool(ctx agent.Context, t tool.Tool, args, result map[string]any, err error) (map[string]any, error) {
	if errors.Is(err, tool.ErrConfirmationRequired) {
		return nil, nil
	}
	if t != nil && t.Name() == toolconfirmation.FunctionCallName {
		return nil, nil
	}
	host := svcplugin.Active()
	if host == nil {
		return nil, nil
	}
	input := callbackBase(ctx)
	if t != nil {
		input["name"] = t.Name()
	}
	if ctx != nil {
		input["id"] = ctx.FunctionCallID()
	}
	input["args"] = cloneMap(args)
	if result != nil {
		input["result"] = result
	}
	if err != nil {
		input["error"] = err.Error()
	}
	out, touched := host.RunHook(ctx, svcplugin.HookToolAfter, input, nil)
	if touched["result"] {
		if repl, ok := out["result"].(map[string]any); ok {
			if result != nil {
				replaceMap(result, repl)
				return nil, nil
			}
			notifyToolResult(ctx, t, args, repl, nil)
			return repl, nil
		}
	}
	if touched["error"] {
		if next, ok := out["error"].(string); ok && next != "" {
			wrapped := errors.New(next)
			notifyToolResult(ctx, t, args, nil, wrapped)
			return nil, wrapped
		}
	}
	return nil, nil
}

func (h *hookBridge) rewriteSystem(ctx agent.Context, host *svcplugin.Host, req *model.LLMRequest) {
	input := callbackBase(ctx)
	input["text"] = instructionText(req)
	out, touched := host.RunHook(ctx, svcplugin.HookSystemPrompt, input, nil)
	if !touched["text"] && !touched["append"] {
		return
	}
	text := instructionText(req)
	if touched["text"] {
		if next, ok := out["text"].(string); ok {
			text = next
		}
	}
	if touched["append"] {
		if extra, ok := out["append"].(string); ok {
			text += extra
		}
	}
	setInstruction(req, text)
}

func (h *hookBridge) rewriteRequest(ctx agent.Context, host *svcplugin.Host, req *model.LLMRequest) {
	input := callbackBase(ctx)
	input["protocol"] = h.protocol
	input["model"] = req.Model
	input["system"] = instructionText(req)
	input["messages"] = encodeContents(req.Contents)
	input["tools"] = requestToolNames(req)
	if req.Config != nil {
		if req.Config.Temperature != nil {
			input["temperature"] = float64(*req.Config.Temperature)
		}
		if req.Config.MaxOutputTokens != 0 {
			input["maxOutputTokens"] = int64(req.Config.MaxOutputTokens)
		}
	}
	out, touched := host.RunHook(ctx, svcplugin.HookLLMRequest, input, nil)
	if touched["system"] {
		if text, ok := out["system"].(string); ok {
			setInstruction(req, text)
		}
	}
	if touched["messages"] {
		if contents, ok := decodeContents(out["messages"]); ok {
			req.Contents = contents
		}
	}
	if touched["temperature"] {
		if value, ok := asFloat(out["temperature"]); ok {
			cfg := ensureConfig(req)
			temp := float32(value)
			cfg.Temperature = &temp
		}
	}
	if touched["maxOutputTokens"] {
		if value, ok := asFloat(out["maxOutputTokens"]); ok {
			ensureConfig(req).MaxOutputTokens = int32(value)
		}
	}
	if touched["dropTools"] {
		dropRequestedTools(req, asStrings(out["dropTools"]))
	}
	if touched["foldToolResults"] {
		foldRequestToolResults(req, asStrings(out["foldToolResults"]))
	}
	if touched["body"] {
		if body, ok := out["body"].(map[string]any); ok {
			provider.SetWireBody(req, body)
		}
	}
}

func (h *hookBridge) rememberWire(id string, req *model.LLMRequest) {
	if req == nil {
		return
	}
	if prev, ok := h.wires.Load(id); ok {
		if old, _ := prev.(*model.LLMRequest); old != nil && old != req {
			provider.TakeWireBody(old)
			provider.SetRequestObserver(old, nil)
		}
	}
	h.wires.Store(id, req)
}

func (h *hookBridge) releaseWire(id string) {
	value, ok := h.wires.LoadAndDelete(id)
	if !ok {
		return
	}
	req, _ := value.(*model.LLMRequest)
	provider.TakeWireBody(req)
	provider.SetRequestObserver(req, nil)
}

// Copy on write: fold only the outgoing response payload, preserving call IDs,
// other parts (including images), and the original session transcript.
func foldRequestToolResults(req *model.LLMRequest, ids []string) {
	if len(ids) == 0 {
		return
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		if id != "" {
			wanted[id] = true
		}
	}
	contents := append([]*genai.Content(nil), req.Contents...)
	for i, content := range contents {
		if content == nil {
			continue
		}
		var copied *genai.Content
		for j, part := range content.Parts {
			if part == nil || part.FunctionResponse == nil || !wanted[part.FunctionResponse.ID] {
				continue
			}
			if copied == nil {
				value := *content
				value.Parts = append([]*genai.Part(nil), content.Parts...)
				copied = &value
				contents[i] = copied
			}
			value := *part
			response := *part.FunctionResponse
			response.Response = map[string]any{"text": "[此工具结果已由用户在上下文透镜中折叠；原始结果保留在会话记录。]"}
			value.FunctionResponse = &response
			copied.Parts[j] = &value
		}
	}
	req.Contents = contents
}

func invocationBase(ctx agent.InvocationContext) map[string]any {
	input := map[string]any{}
	if ctx == nil {
		return input
	}
	if id := ctx.InvocationID(); id != "" {
		input["invocationId"] = id
	}
	if sess := ctx.Session(); sess != nil {
		if id := sess.ID(); id != "" {
			input["sessionId"] = id
		}
		if app := sess.AppName(); app != "" {
			input["app"] = app
		}
	}
	if current := ctx.Agent(); current != nil && current.Name() != "" {
		input["agent"] = current.Name()
	}
	if parent := parentSessionOf(ctx); parent != "" {
		input["parentSessionId"] = parent
	}
	return input
}

func callbackBase(ctx agent.Context) map[string]any {
	input := map[string]any{}
	if ctx == nil {
		return input
	}
	if id := ctx.InvocationID(); id != "" {
		input["invocationId"] = id
	}
	if id := ctx.SessionID(); id != "" {
		input["sessionId"] = id
	}
	if app := ctx.AppName(); app != "" {
		input["app"] = app
	}
	if name := ctx.AgentName(); name != "" {
		input["agent"] = name
	}
	if parent := parentSessionOf(ctx); parent != "" {
		input["parentSessionId"] = parent
	}
	return input
}

func instructionText(req *model.LLMRequest) string {
	if req == nil || req.Config == nil {
		return ""
	}
	return plainText(req.Config.SystemInstruction)
}

func setInstruction(req *model.LLMRequest, text string) {
	ensureConfig(req).SystemInstruction = &genai.Content{
		Parts: []*genai.Part{{Text: text}},
	}
}

func ensureConfig(req *model.LLMRequest) *genai.GenerateContentConfig {
	if req.Config == nil {
		req.Config = &genai.GenerateContentConfig{}
	}
	return req.Config
}

func plainText(content *genai.Content) string {
	if content == nil {
		return ""
	}
	var b strings.Builder
	for _, part := range content.Parts {
		if isPlainText(part) {
			b.WriteString(part.Text)
		}
	}
	return b.String()
}

func isPlainText(part *genai.Part) bool {
	return part != nil && part.Text != "" && !part.Thought && part.FunctionCall == nil && part.FunctionResponse == nil && part.InlineData == nil && part.FileData == nil
}

func rewriteUserContent(content *genai.Content, text string) *genai.Content {
	role := genai.RoleUser
	var kept []*genai.Part
	if content != nil {
		if content.Role != "" {
			role = content.Role
		}
		for _, part := range content.Parts {
			if part == nil || isPlainText(part) {
				continue
			}
			kept = append(kept, part)
		}
	}
	parts := make([]*genai.Part, 0, 1+len(kept))
	if text != "" || len(kept) == 0 {
		parts = append(parts, &genai.Part{Text: text})
	}
	parts = append(parts, kept...)
	return &genai.Content{Role: role, Parts: parts}
}

func setPlainText(content *genai.Content, text string) {
	if content == nil {
		return
	}
	var kept []*genai.Part
	replaced := false
	for _, part := range content.Parts {
		if part == nil || isPlainText(part) {
			if !replaced {
				kept = append(kept, &genai.Part{Text: text})
				replaced = true
			}
			continue
		}
		kept = append(kept, part)
	}
	if !replaced {
		kept = append([]*genai.Part{{Text: text}}, kept...)
	}
	content.Parts = kept
}

func applyCompact(content *genai.Content, out map[string]any, touched map[string]bool) bool {
	if touched["drop"] {
		if drop, ok := out["drop"].(bool); ok && drop {
			return true
		}
	}
	text := plainText(content)
	if touched["summary"] {
		if summary, ok := out["summary"].(string); ok && summary != "" {
			text = summary
		}
	}
	if touched["keep"] {
		if extra := keepText(out["keep"]); extra != "" {
			if text != "" {
				text += "\n"
			}
			text += extra
		}
	}
	if text != plainText(content) {
		setPlainText(content, text)
	}
	return false
}

func keepText(value any) string {
	switch item := value.(type) {
	case string:
		return item
	case []any:
		var b strings.Builder
		for _, raw := range item {
			text, ok := raw.(string)
			if !ok || text == "" {
				continue
			}
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(text)
		}
		return b.String()
	default:
		return ""
	}
}

func encodeContents(contents []*genai.Content) []any {
	out := make([]any, 0, len(contents))
	for _, content := range contents {
		if content == nil {
			continue
		}
		item := map[string]any{"role": content.Role, "text": plainText(content)}
		parts := make([]any, 0, len(content.Parts))
		for _, part := range content.Parts {
			if part == nil {
				continue
			}
			switch {
			case part.FunctionCall != nil:
				parts = append(parts, map[string]any{"functionCall": map[string]any{
					"id": part.FunctionCall.ID, "name": part.FunctionCall.Name, "args": part.FunctionCall.Args,
				}})
			case part.FunctionResponse != nil:
				parts = append(parts, map[string]any{"functionResponse": map[string]any{
					"id": part.FunctionResponse.ID, "name": part.FunctionResponse.Name, "response": part.FunctionResponse.Response,
				}})
			case part.Thought:
				parts = append(parts, map[string]any{"thought": part.Text})
			case part.Text != "":
				parts = append(parts, map[string]any{"text": part.Text})
			}
		}
		item["parts"] = parts
		out = append(out, item)
	}
	return out
}

func decodeContents(value any) ([]*genai.Content, bool) {
	list, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := make([]*genai.Content, 0, len(list))
	for _, raw := range list {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		content := &genai.Content{Role: asString(item["role"])}
		if parts, ok := item["parts"].([]any); ok {
			for _, rawPart := range parts {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				switch {
				case part["functionCall"] != nil:
					call, _ := part["functionCall"].(map[string]any)
					args, _ := call["args"].(map[string]any)
					content.Parts = append(content.Parts, &genai.Part{FunctionCall: &genai.FunctionCall{
						ID: asString(call["id"]), Name: asString(call["name"]), Args: args,
					}})
				case part["functionResponse"] != nil:
					response, _ := part["functionResponse"].(map[string]any)
					payload, _ := response["response"].(map[string]any)
					content.Parts = append(content.Parts, &genai.Part{FunctionResponse: &genai.FunctionResponse{
						ID: asString(response["id"]), Name: asString(response["name"]), Response: payload,
					}})
				case part["thought"] != nil:
					content.Parts = append(content.Parts, &genai.Part{Text: asString(part["thought"]), Thought: true})
				default:
					if text, ok := part["text"].(string); ok {
						content.Parts = append(content.Parts, &genai.Part{Text: text})
					}
				}
			}
		} else if text, ok := item["text"].(string); ok {
			content.Parts = []*genai.Part{{Text: text}}
		}
		if content.Role == "" {
			content.Role = genai.RoleUser
		}
		out = append(out, content)
	}
	return out, true
}

func splitResponse(content *genai.Content) (string, string, []any) {
	if content == nil {
		return "", "", []any{}
	}
	var text, thought strings.Builder
	calls := []any{}
	for _, part := range content.Parts {
		if part == nil {
			continue
		}
		if part.FunctionCall != nil {
			calls = append(calls, map[string]any{
				"id": part.FunctionCall.ID, "name": part.FunctionCall.Name, "args": part.FunctionCall.Args,
			})
			continue
		}
		if part.Thought {
			thought.WriteString(part.Text)
			continue
		}
		if part.Text != "" && part.FunctionResponse == nil {
			text.WriteString(part.Text)
		}
	}
	return text.String(), thought.String(), calls
}

func applyModelResponse(resp *model.LLMResponse, out map[string]any, touched map[string]bool) {
	if resp == nil || (!touched["text"] && !touched["thought"] && !touched["toolCalls"]) {
		return
	}
	text, thought, calls := splitResponse(resp.Content)
	if touched["text"] {
		if next, ok := out["text"].(string); ok {
			text = next
		}
	}
	if touched["thought"] {
		if next, ok := out["thought"].(string); ok {
			thought = next
		}
	}
	if touched["toolCalls"] {
		calls = asCallList(out["toolCalls"])
	}
	content := resp.Content
	if content == nil {
		content = &genai.Content{Role: genai.RoleModel}
		resp.Content = content
	}
	var parts []*genai.Part
	if thought != "" {
		parts = append(parts, &genai.Part{Text: thought, Thought: true})
	}
	if text != "" {
		parts = append(parts, &genai.Part{Text: text})
	}
	for _, raw := range calls {
		call, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		args, _ := call["args"].(map[string]any)
		parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{
			ID: asString(call["id"]), Name: asString(call["name"]), Args: args,
		}})
	}
	content.Parts = parts
	if content.Role == "" {
		content.Role = genai.RoleModel
	}
}

func asCallList(value any) []any {
	switch list := value.(type) {
	case []any:
		return list
	default:
		return []any{}
	}
}

func requestToolNames(req *model.LLMRequest) []string {
	seen := map[string]struct{}{}
	if req != nil {
		for name := range req.Tools {
			seen[name] = struct{}{}
		}
		if req.Config != nil {
			for _, group := range req.Config.Tools {
				if group == nil {
					continue
				}
				for _, fn := range group.FunctionDeclarations {
					if fn != nil && fn.Name != "" {
						seen[fn.Name] = struct{}{}
					}
				}
			}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func dropRequestedTools(req *model.LLMRequest, names []string) {
	if req == nil || len(names) == 0 {
		return
	}
	drop := map[string]struct{}{}
	for _, name := range names {
		if name != "" {
			drop[name] = struct{}{}
		}
	}
	if len(drop) == 0 {
		return
	}
	for name := range drop {
		delete(req.Tools, name)
	}
	if req.Config == nil {
		return
	}
	for _, group := range req.Config.Tools {
		if group == nil || len(group.FunctionDeclarations) == 0 {
			continue
		}
		kept := make([]*genai.FunctionDeclaration, 0, len(group.FunctionDeclarations))
		for _, fn := range group.FunctionDeclarations {
			if fn == nil {
				continue
			}
			if _, skip := drop[fn.Name]; skip {
				continue
			}
			kept = append(kept, fn)
		}
		group.FunctionDeclarations = kept
	}
}

func cloneMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func replaceMap(dst, src map[string]any) {
	if dst == nil {
		return
	}
	cloned := cloneMap(src)
	for key := range dst {
		delete(dst, key)
	}
	for key, value := range cloned {
		dst[key] = value
	}
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func asStrings(value any) []string {
	switch list := value.(type) {
	case []string:
		return list
	case []any:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if text, ok := item.(string); ok && text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func asFloat(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		parsed, err := n.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

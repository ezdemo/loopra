package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

func (c *Client) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	update, ok := localUpdate(params.Update)
	if !ok {
		return nil
	}
	c.mu.Lock()
	replaying := c.replaying
	current := c.sessionID
	c.mu.Unlock()
	if replaying {
		c.captureReplay(update)
		return nil
	}
	child := ""
	sessionID := string(params.SessionId)
	if current != "" && sessionID != current {
		c.mu.Lock()
		known := c.children[sessionID]
		c.mu.Unlock()
		if !known {
			return nil
		}
		child = sessionID
	}
	if update.SessionUpdate == "subagent_spawned" && update.SubagentSessionID != "" {
		c.mu.Lock()
		if c.childSupported {
			c.children[update.SubagentSessionID] = true
		}
		c.mu.Unlock()
	}
	event, ok := c.toEvent(update)
	if !ok {
		return nil
	}
	if child != "" {
		event.SubSession = child
	}
	if c.handler != nil {
		c.handler(event)
	}
	return nil
}

func (c *Client) RequestPermission(ctx context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	request := PermissionRequest{
		SessionID: string(params.SessionId),
		Meta:      params.Meta,
		ToolCall: ToolCallRef{
			ToolCallID: string(params.ToolCall.ToolCallId),
			RawInput:   params.ToolCall.RawInput,
		},
	}
	if params.ToolCall.Title != nil {
		request.ToolCall.Title = *params.ToolCall.Title
	}
	if params.ToolCall.Kind != nil {
		request.ToolCall.Kind = string(*params.ToolCall.Kind)
	}
	if params.ToolCall.Status != nil {
		request.ToolCall.Status = string(*params.ToolCall.Status)
	}
	for _, option := range params.Options {
		request.Options = append(request.Options, PermissionOption{
			OptionID: string(option.OptionId), Name: option.Name, Kind: string(option.Kind),
		})
	}
	logging.Infof("acp", "permission requested tool=%q options=%d", request.ToolCall.Title, len(request.Options))
	cancelled := acpsdk.RequestPermissionResponse{Outcome: acpsdk.RequestPermissionOutcome{
		Cancelled: &acpsdk.RequestPermissionOutcomeCancelled{Outcome: "cancelled"},
	}}
	if c.perm == nil {
		return cancelled, nil
	}
	option, ok := c.perm(ctx, request)
	if !ok || option == "" {
		logging.Infof("acp", "permission cancelled tool=%q", request.ToolCall.Title)
		return cancelled, nil
	}
	logging.Infof("acp", "permission answered tool=%q option=%q", request.ToolCall.Title, option)
	return acpsdk.RequestPermissionResponse{Outcome: acpsdk.RequestPermissionOutcome{
		Selected: &acpsdk.RequestPermissionOutcomeSelected{
			Outcome: "selected", OptionId: acpsdk.PermissionOptionId(option),
		},
	}}, nil
}

func (c *Client) UnstableCreateElicitation(ctx context.Context, params acpsdk.UnstableCreateElicitationRequest) (acpsdk.UnstableCreateElicitationResponse, error) {
	cancel := acpsdk.NewUnstableCreateElicitationResponseCancel()
	if params.Form == nil {
		return cancel, nil
	}
	c.mu.Lock()
	handler := c.elicit
	c.mu.Unlock()
	if handler == nil {
		return cancel, nil
	}
	schema := map[string]any{"type": "object", "properties": params.Form.RequestedSchema.Properties}
	if len(params.Form.RequestedSchema.Required) > 0 {
		schema["required"] = params.Form.RequestedSchema.Required
	}
	result := handler(ctx, ElicitationRequest{
		Message: params.Form.Message, Mode: "form", RequestedSchema: schema, Meta: params.Form.Meta,
	})
	switch result.Action {
	case "accept":
		accepted := acpsdk.NewUnstableCreateElicitationResponseAccept()
		accepted.Accept.Content = result.Content
		return accepted, nil
	case "decline":
		return acpsdk.NewUnstableCreateElicitationResponseDecline(), nil
	default:
		return cancel, nil
	}
}

func (c *Client) UnstableCompleteElicitation(context.Context, acpsdk.UnstableCompleteElicitationNotification) error {
	return nil
}

func (c *Client) ReadTextFile(context.Context, acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, fmt.Errorf("客户端未开启文件读取")
}

func (c *Client) WriteTextFile(context.Context, acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, fmt.Errorf("客户端未开启文件写入")
}

func (c *Client) CreateTerminal(context.Context, acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, fmt.Errorf("客户端未开启终端")
}

func (c *Client) KillTerminal(context.Context, acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, fmt.Errorf("客户端未开启终端")
}

func (c *Client) TerminalOutput(context.Context, acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, fmt.Errorf("客户端未开启终端")
}

func (c *Client) ReleaseTerminal(context.Context, acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, fmt.Errorf("客户端未开启终端")
}

func (c *Client) WaitForTerminalExit(context.Context, acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, fmt.Errorf("客户端未开启终端")
}

func (c *Client) captureReplay(update SessionUpdate) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch update.SessionUpdate {
	case "plan":
		c.replayPlan = normalizePlan(update.Entries)
	case "available_commands_update":
		c.replayCommands = normalizeCommands(update.AvailableCommands)
	case "config_option_update":
		c.replayConfig = update.ConfigOptions
		c.configOptions = update.ConfigOptions
		c.configSupported = true
	}
}

func normalizePlan(entries []PlanEntry) []PlanEntry {
	out := make([]PlanEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Content == "" || entry.Status == "" {
			continue
		}
		switch entry.Status {
		case "pending", "in_progress", "completed":
		default:
			continue
		}
		if entry.Priority == "" {
			entry.Priority = "medium"
		}
		out = append(out, entry)
	}
	return out
}

func normalizeCommands(commands []Command) []Command {
	out := make([]Command, 0, len(commands))
	seen := map[string]bool{}
	for _, command := range commands {
		if command.Name == "" || strings.ContainsAny(command.Name, " \t\n") || seen[command.Name] {
			continue
		}
		seen[command.Name] = true
		out = append(out, command)
	}
	return out
}

func (c *Client) toEvent(update SessionUpdate) (Event, bool) {
	event := Event{Meta: update.Meta}
	switch update.SessionUpdate {
	case "agent_message_chunk":
		if native, ok := nativeEvent(update.Meta); ok {
			event.Kind, event.NativeType, event.NativeData = EventNative, native.typ, native.data
			return event, true
		}
		block, ok := update.ChunkContent()
		if !ok || block.Type != "text" || block.Text == "" {
			return Event{}, false
		}
		event.Kind, event.Text = EventContent, block.Text
	case "agent_thought_chunk":
		block, ok := update.ChunkContent()
		if !ok || block.Type != "text" || block.Text == "" {
			return Event{}, false
		}
		event.Kind, event.Text = EventReason, block.Text
	case "tool_call", "tool_call_update":
		copy := update
		event.Kind, event.Tool = EventToolCall, &copy
	case "plan":
		event.Kind, event.Plan = EventPlan, normalizePlan(update.Entries)
	case "available_commands_update":
		event.Kind, event.Commands = EventCommands, normalizeCommands(update.AvailableCommands)
	case "current_mode_update":
		event.Kind, event.Mode = EventMode, update.CurrentModeID
	case "config_option_update":
		c.mu.Lock()
		c.configOptions = update.ConfigOptions
		c.configSupported = true
		c.mu.Unlock()
		event.Kind, event.ConfigOptions = EventConfig, update.ConfigOptions
	case "usage_update":
		event.Kind, event.Used, event.Size, event.Cost = EventUsage, update.Used, update.Size, update.Cost
		if update.Meta != nil {
			if model, ok := update.Meta["model"].(string); ok && model != "" {
				event.Model = model
			}
			if model, ok := update.Meta["_claude/model"].(string); ok && model != "" {
				event.Model = model
			}
		}
	case "subagent_spawned", "subagent_state_update":
		c.mu.Lock()
		supported := c.childSupported
		c.mu.Unlock()
		if !supported || update.SubagentSessionID == "" {
			return Event{}, false
		}
		copy := update
		event.Subagent, event.SubSession = &copy, update.SubagentSessionID
		if update.SessionUpdate == "subagent_spawned" {
			event.Kind = EventSubSpawned
		} else {
			event.Kind = EventSubState
		}
	default:
		return Event{}, false
	}
	return event, true
}

type nativePayload struct {
	typ  string
	data json.RawMessage
}

// nativeEvent 解析适配器通过 loopra.dev/event 注入的原生事件。
func nativeEvent(meta map[string]any) (nativePayload, bool) {
	if meta == nil {
		return nativePayload{}, false
	}
	raw, ok := meta["loopra.dev/event"]
	if !ok {
		return nativePayload{}, false
	}
	payload, ok := raw.(map[string]any)
	if !ok {
		return nativePayload{}, false
	}
	kind, _ := payload["type"].(string)
	if kind == "" {
		return nativePayload{}, false
	}
	switch value := payload["data"].(type) {
	case string:
		if json.Valid([]byte(value)) {
			return nativePayload{typ: kind, data: []byte(value)}, true
		}
		data, err := json.Marshal(value)
		if err != nil {
			return nativePayload{}, false
		}
		return nativePayload{typ: kind, data: data}, true
	default:
		data, err := json.Marshal(value)
		if err != nil {
			return nativePayload{}, false
		}
		return nativePayload{typ: kind, data: data}, true
	}
}

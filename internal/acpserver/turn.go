package acpserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func (s *liveSession) run(ctx context.Context, runtime *Runtime, blocks []acpsdk.ContentBlock) (acpsdk.StopReason, error) {
	content := userContent(blocks)
	sess, err := s.agent.Session(ctx, s.id)
	if err != nil {
		return "", err
	}
	sink := &toolSink{sent: map[string]bool{}, emit: func(update acpsdk.SessionUpdate) {
		s.emit(ctx, runtime, update)
	}}
	for {
		if err := ctx.Err(); err != nil {
			return acpsdk.StopReasonCancelled, nil
		}
		pendings, err := s.drive(ctx, runtime, sess, content, sink)
		if err != nil {
			if ctx.Err() != nil {
				return acpsdk.StopReasonCancelled, nil
			}
			return "", err
		}
		if len(pendings) == 0 {
			return acpsdk.StopReasonEndTurn, nil
		}
		responses := make([]*genai.Part, 0, len(pendings))
		for _, pending := range pendings {
			approved, err := s.permit(ctx, runtime, pending)
			if err != nil || ctx.Err() != nil {
				return acpsdk.StopReasonCancelled, nil
			}
			responses = append(responses, &genai.Part{FunctionResponse: &genai.FunctionResponse{
				Name: toolconfirmation.FunctionCallName, ID: pending.confirmID,
				Response: map[string]any{"confirmed": approved},
			}})
		}
		content = &genai.Content{Role: genai.RoleUser, Parts: responses}
	}
}

type pendingConfirm struct {
	confirmID string
	name      string
	args      map[string]any
}

func (s *liveSession) drive(ctx context.Context, runtime *Runtime, sess session.Session, content *genai.Content, sink *toolSink) ([]pendingConfirm, error) {
	ctx = tools.WithLinkedProjects(ctx, s.dirs)
	ctx = agentpkg.WithToolResultSink(ctx, sink)
	var pendings []pendingConfirm
	streamedText := false
	streamedReasoning := false
	var lastPrompt int64
	for ev, err := range s.agent.Run(ctx, sess, content) {
		if err != nil {
			return pendings, err
		}
		if ev.Content == nil {
			lastPrompt = notePrompt(lastPrompt, ev)
			continue
		}
		if ev.Partial {
			for _, part := range ev.Content.Parts {
				if part == nil || part.Text == "" {
					continue
				}
				if part.Thought {
					streamedReasoning = true
					s.emit(ctx, runtime, acpsdk.UpdateAgentThoughtText(part.Text))
					continue
				}
				streamedText = true
				s.emit(ctx, runtime, acpsdk.UpdateAgentMessageText(part.Text))
			}
			continue
		}
		lastPrompt = notePrompt(lastPrompt, ev)
		s.emitUsage(ctx, runtime, lastPrompt)
		if !streamedReasoning {
			for _, part := range ev.Content.Parts {
				if part != nil && part.Text != "" && part.Thought {
					s.emit(ctx, runtime, acpsdk.UpdateAgentThoughtText(part.Text))
				}
			}
		}
		if !streamedText {
			if text := visibleText(ev); text != "" {
				s.emit(ctx, runtime, acpsdk.UpdateAgentMessageText(text))
			}
		}
		streamedReasoning = false
		streamedText = false
		for _, part := range ev.Content.Parts {
			switch {
			case part.FunctionCall != nil && part.FunctionCall.Name == toolconfirmation.FunctionCallName:
				orig, err := toolconfirmation.OriginalCallFrom(part.FunctionCall)
				if err != nil || orig == nil {
					continue
				}
				args := orig.Args
				s.emit(ctx, runtime, acpsdk.StartToolCall(acpsdk.ToolCallId(part.FunctionCall.ID), orig.Name,
					acpsdk.WithStartKind(toolKind(orig.Name)),
					acpsdk.WithStartStatus(acpsdk.ToolCallStatusPending),
					acpsdk.WithStartRawInput(args),
				))
				pendings = append(pendings, pendingConfirm{confirmID: part.FunctionCall.ID, name: orig.Name, args: args})
			case part.FunctionCall != nil:
				args := part.FunctionCall.Args
				s.emit(ctx, runtime, acpsdk.SessionUpdate{ToolCall: &acpsdk.SessionUpdateToolCall{
					ToolCallId: acpsdk.ToolCallId(part.FunctionCall.ID),
					Title:      part.FunctionCall.Name,
					Kind:       toolKind(part.FunctionCall.Name),
					Status:     acpsdk.ToolCallStatusInProgress,
					RawInput:   args,
					Meta:       map[string]any{"loopra.dev/toolName": part.FunctionCall.Name},
				}})
			case part.FunctionResponse != nil && pendingConfirmation(part.FunctionResponse):
			case part.FunctionResponse != nil:
				if sink.sentAlready(part.FunctionResponse.ID) {
					continue
				}
				s.emitToolResult(ctx, runtime, part.FunctionResponse.ID, part.FunctionResponse.Name, part.FunctionResponse.Response)
				sink.mark(part.FunctionResponse.ID)
			}
		}
	}
	return pendings, nil
}

func (s *liveSession) permit(ctx context.Context, runtime *Runtime, pending pendingConfirm) (bool, error) {
	runtime.mu.Lock()
	conn := runtime.conn
	runtime.mu.Unlock()
	if conn == nil {
		return false, nil
	}
	response, err := conn.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
		SessionId: acpsdk.SessionId(s.id),
		ToolCall: acpsdk.ToolCallUpdate{
			ToolCallId: acpsdk.ToolCallId(pending.confirmID),
			Title:      acpsdk.Ptr(pending.name),
			Kind:       acpsdk.Ptr(toolKind(pending.name)),
			Status:     acpsdk.Ptr(acpsdk.ToolCallStatusPending),
			RawInput:   pending.args,
		},
		Options: []acpsdk.PermissionOption{
			{OptionId: "allow_once", Name: "允许一次", Kind: acpsdk.PermissionOptionKindAllowOnce},
			{OptionId: "reject_once", Name: "拒绝", Kind: acpsdk.PermissionOptionKindRejectOnce},
		},
	})
	if err != nil {
		return false, err
	}
	if response.Outcome.Selected == nil {
		return false, nil
	}
	switch response.Outcome.Selected.OptionId {
	case "allow_once", "allow_always":
		return true, nil
	default:
		return false, nil
	}
}

func (s *liveSession) emit(ctx context.Context, runtime *Runtime, update acpsdk.SessionUpdate) {
	runtime.mu.Lock()
	conn := runtime.conn
	runtime.mu.Unlock()
	if conn == nil {
		return
	}
	_ = conn.SessionUpdate(ctx, acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(s.id), Update: update,
	})
}

func (s *liveSession) emitToolResult(ctx context.Context, runtime *Runtime, id, name string, response map[string]any) {
	text, failed := resultText(response)
	status := acpsdk.ToolCallStatusCompleted
	if failed {
		status = acpsdk.ToolCallStatusFailed
	}
	s.emit(ctx, runtime, acpsdk.UpdateToolCall(acpsdk.ToolCallId(id),
		acpsdk.WithUpdateTitle(name),
		acpsdk.WithUpdateStatus(status),
		acpsdk.WithUpdateContent([]acpsdk.ToolCallContent{
			acpsdk.ToolContent(acpsdk.TextBlock(text)),
		}),
	))
}

type toolSink struct {
	mu   sync.Mutex
	sent map[string]bool
	emit func(acpsdk.SessionUpdate)
}

func (s *toolSink) ToolFinished(id, name string, response map[string]any) {
	if !s.mark(id) {
		return
	}
	text, failed := resultText(response)
	status := acpsdk.ToolCallStatusCompleted
	if failed {
		status = acpsdk.ToolCallStatusFailed
	}
	s.emit(acpsdk.UpdateToolCall(acpsdk.ToolCallId(id),
		acpsdk.WithUpdateTitle(name),
		acpsdk.WithUpdateStatus(status),
		acpsdk.WithUpdateContent([]acpsdk.ToolCallContent{
			acpsdk.ToolContent(acpsdk.TextBlock(text)),
		}),
	))
}

func (s *toolSink) ToolResultSent(id string) bool { return s.sentAlready(id) }

func (s *toolSink) mark(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sent[id] {
		return false
	}
	s.sent[id] = true
	return true
}

func (s *toolSink) sentAlready(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sent[id]
}

func userContent(blocks []acpsdk.ContentBlock) *genai.Content {
	parts := make([]*genai.Part, 0, len(blocks))
	for _, block := range blocks {
		switch {
		case block.Text != nil && block.Text.Text != "":
			parts = append(parts, &genai.Part{Text: block.Text.Text})
		case block.Image != nil && block.Image.Data != "":
			data, err := base64.StdEncoding.DecodeString(block.Image.Data)
			if err != nil {
				continue
			}
			parts = append(parts, &genai.Part{InlineData: &genai.Blob{MIMEType: block.Image.MimeType, Data: data}})
		case block.ResourceLink != nil && block.ResourceLink.Uri != "":
			parts = append(parts, &genai.Part{Text: block.ResourceLink.Uri})
		}
	}
	if len(parts) == 0 {
		parts = append(parts, &genai.Part{Text: "(empty)"})
	}
	return &genai.Content{Role: genai.RoleUser, Parts: parts}
}

func visibleText(ev *session.Event) string {
	if ev == nil || ev.Content == nil {
		return ""
	}
	var b strings.Builder
	for _, part := range ev.Content.Parts {
		if part != nil && part.Text != "" && !part.Thought {
			b.WriteString(part.Text)
		}
	}
	return b.String()
}

func notePrompt(previous int64, ev *session.Event) int64 {
	if ev == nil || ev.UsageMetadata == nil || ev.UsageMetadata.PromptTokenCount <= 0 {
		return previous
	}
	return int64(ev.UsageMetadata.PromptTokenCount)
}

func (s *liveSession) emitUsage(ctx context.Context, runtime *Runtime, used int64) {
	if used <= 0 {
		return
	}
	update := &acpsdk.SessionUsageUpdate{Used: int(used)}
	if window := s.contextWindow(); window > 0 {
		update.Size = window
	}
	s.mu.Lock()
	modelName := s.model
	s.mu.Unlock()
	if modelName != "" {
		update.Meta = map[string]any{"model": modelName}
	}
	s.emit(ctx, runtime, acpsdk.SessionUpdate{UsageUpdate: update})
}

func (s *liveSession) contextWindow() int {
	s.mu.Lock()
	name, channelID, cfg := s.model, s.channel, s.cfg
	s.mu.Unlock()
	if cfg == nil || name == "" {
		return 0
	}
	if channel, ok := cfg.ChannelByID(channelID); ok {
		for _, model := range channel.Models {
			if model.Name == name && model.ContextTokens > 0 {
				return int(model.ContextTokens)
			}
		}
	}
	for _, channel := range cfg.ModelChannels {
		for _, model := range channel.Models {
			if model.Name == name && model.ContextTokens > 0 {
				return int(model.ContextTokens)
			}
		}
	}
	return 0
}

func pendingConfirmation(response *genai.FunctionResponse) bool {
	message, _ := response.Response["error"].(string)
	return strings.Contains(message, "requires confirmation, please approve or reject")
}

func resultText(response map[string]any) (string, bool) {
	if response == nil {
		return "", false
	}
	if message, ok := response["error"].(string); ok && message != "" {
		return message, true
	}
	if text, ok := response["result"].(string); ok {
		return text, false
	}
	raw, err := json.Marshal(response)
	if err != nil {
		return "", false
	}
	return string(raw), false
}

func toolKind(name string) acpsdk.ToolKind {
	switch name {
	case "read", "rg":
		return acpsdk.ToolKindRead
	case "write", "edit":
		return acpsdk.ToolKindEdit
	case "bash", "sh", "powershell", "CMD":
		return acpsdk.ToolKindExecute
	default:
		return acpsdk.ToolKindOther
	}
}

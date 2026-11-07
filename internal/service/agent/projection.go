package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"iter"
	"strings"
	"time"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/platform"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/model/config"
)

// projectedSessions is used only by runners. The application's original
// service still returns the full transcript. Durable decisions store the
// chosen payload, so changing budgets does not rewrite a warmed prefix.
type projectedSessions struct {
	session.Service
	prune config.ToolResultPrune
}

func (r *ContextRuntime) SessionService(base session.Service, cfg *config.Loopra) session.Service {
	if r.config == nil {
		return base
	}
	prune := cfg.ContextCompaction.ToolResultPrune
	if prune.ThresholdChars == 0 {
		prune = config.ToolResultPrune{ThresholdChars: 8192, HeadChars: 4096, TailChars: 1024}
	}
	if prune.ThresholdChars < 0 {
		return base
	}
	return &projectedSessions{Service: base, prune: prune}
}

func (s *projectedSessions) Get(ctx context.Context, req *session.GetRequest) (*session.GetResponse, error) {
	got, err := s.Service.Get(ctx, req)
	if err != nil {
		return nil, err
	}
	// Rebuild decisions from logged deltas before considering changed budgets.
	for event := range got.Session.Events().All() {
		if event != nil {
			if err := applyProjectionState(got.Session, event.Actions.StateDelta); err != nil {
				return nil, err
			}
		}
	}
	if err := s.ensure(ctx, got.Session); err != nil {
		return nil, err
	}
	got.Session = &projectedSession{Session: got.Session}
	return got, nil
}

func (s *projectedSessions) AppendEvent(ctx context.Context, current session.Session, event *session.Event) error {
	raw := rawSession(current)
	if event != nil && !event.Partial {
		// The full result and its projection decision share one backend append.
		if event.ID == "" {
			event.ID = platform.NewUUID(ctx)
		}
		delta := s.decisions(raw, event)
		if len(delta) > 0 {
			copy := *event
			copy.Actions = event.Actions
			copy.Actions.StateDelta = make(map[string]any, len(event.Actions.StateDelta)+len(delta))
			for key, value := range event.Actions.StateDelta {
				copy.Actions.StateDelta[key] = value
			}
			for key, value := range delta {
				copy.Actions.StateDelta[key] = value
			}
			event = &copy
		}
	}
	if err := s.Service.AppendEvent(ctx, raw, event); err != nil {
		return err
	}
	if event != nil && !event.Partial {
		return applyProjectionState(raw, event.Actions.StateDelta)
	}
	return nil
}

func (s *projectedSessions) ensure(ctx context.Context, current session.Session) error {
	for event := range current.Events().All() {
		delta := s.decisions(current, event)
		if len(delta) == 0 {
			continue
		}
		record := &session.Event{
			Author: "loopra-context", Timestamp: time.Now(),
			Branch: event.Branch, IsolationScope: event.IsolationScope,
			Actions:     session.EventActions{StateDelta: delta},
			LLMResponse: model.LLMResponse{CustomMetadata: map[string]any{"webHidden": true}},
		}
		if err := s.Service.AppendEvent(ctx, current, record); err != nil {
			return err
		}
		if err := applyProjectionState(current, delta); err != nil {
			return err
		}
	}
	return nil
}

func applyProjectionState(current session.Session, delta map[string]any) error {
	for key, value := range delta {
		if strings.HasPrefix(key, "loopra:toolProjection:") {
			if err := current.State().Set(key, value); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *projectedSessions) decisions(current session.Session, event *session.Event) map[string]any {
	delta := map[string]any{}
	if event == nil || event.Content == nil {
		return delta
	}
	for index, part := range event.Content.Parts {
		if part == nil || part.FunctionResponse == nil {
			continue
		}
		key := projectionKey(event, index)
		if _, err := current.State().Get(key); err == nil {
			continue
		}
		response, changed := pruneResponse(part.FunctionResponse.Response, s.prune, part.FunctionResponse.ID)
		// Store "keep" decisions too: an output first seen below today's
		// threshold must remain unchanged if tomorrow's threshold is smaller.
		value := map[string]any{"keep": true}
		if changed {
			value = map[string]any{"response": response}
		}
		delta[key] = value
	}
	return delta
}

// No ADK Unwrap method: compaction must read the projected view.
type projectedSession struct{ session.Session }

func (s *projectedSession) Events() session.Events {
	return projectedEvents{events: s.Session.Events(), state: s.Session.State()}
}

func rawSession(s session.Session) session.Session {
	if p, ok := s.(*projectedSession); ok {
		return p.Session
	}
	return s
}

type projectedEvents struct {
	events session.Events
	state  session.State
}

func (e projectedEvents) Len() int { return e.events.Len() }
func (e projectedEvents) All() iter.Seq[*session.Event] {
	return func(yield func(*session.Event) bool) {
		for event := range e.events.All() {
			if !yield(e.project(event)) {
				return
			}
		}
	}
}
func (e projectedEvents) At(i int) *session.Event { return e.project(e.events.At(i)) }

func (e projectedEvents) project(event *session.Event) *session.Event {
	if event == nil || event.Content == nil {
		return event
	}
	var out *session.Event
	for index, part := range event.Content.Parts {
		if part == nil || part.FunctionResponse == nil {
			continue
		}
		value, err := e.state.Get(projectionKey(event, index))
		if err != nil {
			continue
		}
		decision, _ := value.(map[string]any)
		response, ok := decision["response"].(map[string]any)
		if !ok {
			continue
		}
		if out == nil {
			copy := *event
			content := *event.Content
			content.Parts = append([]*genai.Part(nil), event.Content.Parts...)
			copy.Content, out = &content, &copy
		}
		copy := *part
		fr := *part.FunctionResponse
		fr.Response = response
		copy.FunctionResponse = &fr
		out.Content.Parts[index] = &copy
	}
	if out != nil {
		return out
	}
	return event
}

func projectionKey(event *session.Event, index int) string {
	raw, _ := json.Marshal(event.Content.Parts[index].FunctionResponse)
	return fmt.Sprintf("loopra:toolProjection:%x", sha256.Sum256(append([]byte(fmt.Sprintf("%s:%d:", event.ID, index)), raw...)))
}

func pruneResponse(response map[string]any, cfg config.ToolResultPrune, callID string) (map[string]any, bool) {
	out := make(map[string]any, len(response))
	changed := false
	for key, value := range response {
		out[key] = value
		switch key {
		case "result", "text", "stdout", "stderr", "output", "content":
			if text, ok := value.(string); ok {
				runes := []rune(text)
				if len(runes) > cfg.ThresholdChars {
					marker := fmt.Sprintf("\n[Output trimmed; read_tool_result callId=%q retrieves the original.]\n", callID)
					budget := max(cfg.ThresholdChars-len([]rune(marker)), 0)
					head := min(max(cfg.HeadChars, 0), budget)
					tail := min(max(cfg.TailChars, 0), budget-head)
					// Very small budgets cannot carry a useful retrieval notice.
					if head+tail == 0 {
						continue
					}
					out[key] = string(runes[:head]) + marker + string(runes[len(runes)-tail:])
					changed = true
				}
			}
		}
	}
	return out, changed
}

type readToolResultInput struct {
	CallID string `json:"callId"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

// OriginalToolResultTool reads from the retained log, including after a restart
// or compaction. The bounded page avoids re-injecting an entire oversized output.
func OriginalToolResultTool(base session.Service) (tool.Tool, error) {
	return functiontool.New[readToolResultInput, map[string]any](functiontool.Config{
		Name:        "read_tool_result",
		Description: "Read a retained tool result by callId. Returns a JSON text page; offset and limit count Unicode characters. Use nextOffset for subsequent pages.",
	}, func(ctx adkagent.Context, input readToolResultInput) (map[string]any, error) {
		if strings.TrimSpace(input.CallID) == "" || input.Offset < 0 || input.Limit < 0 {
			return nil, fmt.Errorf("callId is required; offset and limit must be non-negative")
		}
		got, err := base.Get(ctx, &session.GetRequest{AppName: ctx.AppName(), UserID: ctx.UserID(), SessionID: ctx.SessionID()})
		if err != nil {
			return nil, err
		}
		current := got.Session
		events := current.Events()
		// The tool facade hides IsolationScope. Resolve it from this exact
		// durable call, refusing access when its placement cannot be proven.
		isolation, found := "", false
		for i := events.Len() - 1; i >= 0 && !found; i-- {
			ev := events.At(i)
			if ev == nil || ev.Content == nil || ev.Author != ctx.AgentName() || ev.Branch != ctx.Branch() {
				continue
			}
			for _, part := range ev.Content.Parts {
				if part != nil && part.FunctionCall != nil && part.FunctionCall.ID == ctx.FunctionCallID() && part.FunctionCall.Name == "read_tool_result" {
					isolation, found = ev.IsolationScope, true
				}
			}
		}
		if !found {
			return nil, fmt.Errorf("tool placement is unavailable")
		}
		for i := events.Len() - 1; i >= 0; i-- {
			event := events.At(i)
			if event == nil || event.IsolationScope != isolation ||
				(event.Branch != "" && event.Branch != ctx.Branch() && !strings.HasPrefix(ctx.Branch(), event.Branch+".")) {
				continue
			}
			// A deferred call's final result lives in its completion event,
			// including metadata-only events after an explicit result query.
			if result, ok := event.CustomMetadata["asyncToolResult"].(map[string]any); ok && result["callId"] == input.CallID {
				return toolResultPage(input, result["response"])
			}
			if event.Content == nil {
				continue
			}
			for _, part := range event.Content.Parts {
				if part == nil || part.FunctionResponse == nil || part.FunctionResponse.ID != input.CallID {
					continue
				}
				return toolResultPage(input, part.FunctionResponse.Response)
			}
		}
		return nil, fmt.Errorf("tool result %q is not available in this context", input.CallID)
	})
}

func toolResultPage(input readToolResultInput, response any) (map[string]any, error) {
	raw, err := json.Marshal(response)
	if err != nil {
		return nil, err
	}
	runes := []rune(string(raw))
	start := min(input.Offset, len(runes))
	limit := input.Limit
	if limit == 0 {
		limit = 4000
	}
	end := start + min(min(limit, 8000), len(runes)-start)
	out := map[string]any{"callId": input.CallID, "text": string(runes[start:end]), "totalChars": len(runes)}
	if end < len(runes) {
		out["nextOffset"] = end
	}
	return out, nil
}

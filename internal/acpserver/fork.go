package acpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"
)

// UnstableForkSession 实现 session/fork：复制源会话到分叉点，并继承模型与模式。
func (r *Runtime) UnstableForkSession(ctx context.Context, params acpsdk.UnstableForkSessionRequest) (acpsdk.UnstableForkSessionResponse, error) {
	source, err := r.open(string(params.SessionId), params.Cwd, params.AdditionalDirectories)
	if err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	if err := source.ensure(r); err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	if err := source.mustExist(ctx); err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	forked, err := r.open(newID(), params.Cwd, params.AdditionalDirectories)
	if err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	forked.copySettings(source)
	if servers, err := stableMCP(params.McpServers); err == nil && len(servers) > 0 {
		forked.servers = servers
	} else {
		forked.servers = append([]acpsdk.McpServer(nil), source.servers...)
	}
	if err := forked.ensure(r); err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	if err := copySessionPrefix(ctx, source, forked, params.Meta); err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	options, err := unstableOptions(forked.options())
	if err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	return acpsdk.UnstableForkSessionResponse{
		SessionId:     acpsdk.SessionId(forked.id),
		ConfigOptions: options,
		Modes:         forked.modes(),
	}, nil
}

func (s *liveSession) copySettings(source *liveSession) {
	source.mu.Lock()
	mode, model, channel, effort, fast, plan := source.mode, source.model, source.channel, source.effort, source.fast, source.plan
	source.mu.Unlock()
	s.mu.Lock()
	s.mode, s.model, s.channel, s.effort, s.fast, s.plan = mode, model, channel, effort, fast, plan
	s.stale = true
	s.mu.Unlock()
}

func copySessionPrefix(ctx context.Context, source, dest *liveSession, meta map[string]any) error {
	got, err := source.agent.Sessions.Get(ctx, &session.GetRequest{
		AppName: source.agent.App(), UserID: source.agent.User(), SessionID: source.id,
	})
	if err != nil {
		return err
	}
	events := got.Session.Events()
	cut := forkCut(events, meta)
	created, err := dest.agent.Sessions.Create(ctx, &session.CreateRequest{
		AppName: dest.agent.App(), UserID: dest.agent.User(), SessionID: dest.id,
	})
	if err != nil {
		return err
	}
	for i := 0; i < cut; i++ {
		event := events.At(i)
		clone := *event
		clone.ID = ""
		if err := dest.agent.Sessions.AppendEvent(ctx, created.Session, &clone); err != nil {
			return err
		}
	}
	return nil
}

func forkCut(events session.Events, meta map[string]any) int {
	total := events.Len()
	fingerprint, occurrence, ok := forkPoint(meta)
	if !ok {
		return total
	}
	seen := 0
	for i := 0; i < total; i++ {
		text := assistantText(events.At(i))
		if text == "" || fingerprintOf(text) != fingerprint {
			continue
		}
		seen++
		if seen == occurrence {
			return i + 1
		}
	}
	return total
}

func forkPoint(meta map[string]any) (string, int, bool) {
	jetbrains, _ := meta["jetbrains"].(map[string]any)
	air, _ := jetbrains["air"].(map[string]any)
	fork, _ := air["fork"].(map[string]any)
	if fork == nil {
		return "", 0, false
	}
	fingerprint, _ := fork["messageFingerprint"].(string)
	occurrence := 1
	switch value := fork["messageOccurrence"].(type) {
	case int:
		occurrence = value
	case float64:
		occurrence = int(value)
	case json.Number:
		if parsed, err := value.Int64(); err == nil {
			occurrence = int(parsed)
		}
	}
	if occurrence <= 0 {
		occurrence = 1
	}
	return fingerprint, occurrence, fingerprint != ""
}

func assistantText(event *session.Event) string {
	if event == nil || event.Content == nil || event.Content.Role == genai.RoleUser {
		return ""
	}
	var text strings.Builder
	for _, part := range event.Content.Parts {
		if part != nil && part.Text != "" && !part.Thought && part.FunctionCall == nil && part.FunctionResponse == nil {
			text.WriteString(part.Text)
		}
	}
	return text.String()
}

func fingerprintOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func stableMCP(servers []acpsdk.UnstableMcpServer) ([]acpsdk.McpServer, error) {
	if len(servers) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(servers)
	if err != nil {
		return nil, err
	}
	var out []acpsdk.McpServer
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func unstableOptions(options []acpsdk.SessionConfigOption) ([]acpsdk.UnstableSessionConfigOption, error) {
	raw, err := json.Marshal(options)
	if err != nil {
		return nil, err
	}
	var out []acpsdk.UnstableSessionConfigOption
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

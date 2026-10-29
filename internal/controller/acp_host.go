package controller

import (
	"context"

	"github.com/ezdemo/looprax/internal/service/acp"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

type acpHost struct{ s *Controller }

func (s *Controller) acpHost() acp.SessionHost { return acpHost{s} }

func (h acpHost) App() string {
	if h.s.agent == nil {
		return ""
	}
	return h.s.agent.App()
}

func (h acpHost) Workspace() string { return h.s.workspaceRoot() }

func (h acpHost) LinkedDirs() []string {
	return append([]string(nil), h.s.linkedProjectRoots...)
}

func (h acpHost) Meta(session string) map[string]any { return h.s.sessionMetaRead(session) }

func (h acpHost) SetMeta(session string, kv map[string]any) { h.s.sessionMetaSet(session, kv) }

func (h acpHost) AppendTranscript(session string, lines []map[string]any) error {
	if h.s.agent == nil {
		return nil
	}
	return h.s.agent.Sessions.AppendTranscript(h.s.agent.App(), session, lines)
}

func (h acpHost) SubSessionsDir(session string) string { return h.s.subSessionsDir(session) }

func (h acpHost) MCPServers(agentID string) []any { return h.s.acpMcpServers(agentID) }

func (h acpHost) Permissions() *hitl.Registry { return h.s.permissions }

func (h acpHost) Elicitations() *hitl.ElicitationRegistry { return h.s.elicitations }

func (h acpHost) EnsureTitle(ctx context.Context, session, message string) {
	h.s.ensureSessionTitle(ctx, session, message)
}

type acpSink struct{ w *sseWriter }

func (a acpSink) Send(event string, payload any)    { a.w.send(event, payload) }
func (a acpSink) SendText(event, text string)       { a.w.sendText(event, text) }
func (a acpSink) SendRaw(event string, data []byte) { a.w.sendRaw(event, data) }
func (a acpSink) SendError(message string)          { a.w.sendError(message) }
func (a acpSink) Done()                             { a.w.done() }

func (s *Controller) acpKey(name string) string {
	app := "default"
	if s.agent != nil && s.agent.App() != "" {
		app = s.agent.App()
	}
	return app + "::" + name
}

func (s *Controller) dropACP(name string) {
	if s.acp != nil {
		s.acp.Drop(s.acpKey(name))
	}
}

func (s *Controller) cancelACP(name string) {
	if s.acp != nil {
		s.acp.Cancel(s.acpHost(), name)
	}
}

func (s *Controller) acquireACP(ctx context.Context, name, agentID string) (*acp.Conn, error) {
	return s.acp.Acquire(ctx, s.acpHost(), name, agentID, Version)
}

func (s *Controller) openACPSession(ctx context.Context, name string, conn *acp.Conn, replayHistory bool) ([]acp.ConfigOption, error) {
	return s.acp.OpenSession(ctx, s.acpHost(), name, conn, replayHistory)
}

func (s *Controller) runACPTurn(ctx context.Context, sse *sseWriter, req *chatRequest, msgID string, hasSnapshot bool) {
	s.acp.RunTurn(ctx, s.acpHost(), acpSink{sse}, acp.TurnInput{
		Session: req.SessionName, AgentID: req.AgentID, Message: req.Message, Images: req.Images,
	}, msgID, hasSnapshot, Version)
}

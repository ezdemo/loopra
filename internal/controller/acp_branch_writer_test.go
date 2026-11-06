package controller

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// Model Codex's process-local sessions and cross-process writer ownership.
// A fork can read another process's source, but resume cannot take its writer.
func TestACPBranchWriterWorker(t *testing.T) {
	dir := os.Getenv("LOOPRA_TEST_ACP_BRANCH_DIR")
	if dir == "" {
		return
	}
	agent := &branchWriterTestAgent{dir: dir, owned: map[string]bool{}}
	agent.conn = acpsdk.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	<-agent.conn.Done()
	os.Exit(0)
}

type branchWriterTestAgent struct {
	writerTestAgent
	dir   string
	mu    sync.Mutex
	owned map[string]bool
}

func (a *branchWriterTestAgent) claim(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.owned[id] {
		return nil
	}
	if err := os.Mkdir(filepath.Join(a.dir, id), 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return acpsdk.NewInvalidRequest(map[string]any{
				"reason": acp.ReasonThreadActiveWriter, "threadId": id,
			})
		}
		return err
	}
	a.owned[id] = true
	return nil
}

func (a *branchWriterTestAgent) NewSession(context.Context, acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	id := newUUIDv4()
	return acpsdk.NewSessionResponse{SessionId: acpsdk.SessionId(id)}, a.claim(id)
}

func (a *branchWriterTestAgent) LoadSession(_ context.Context, req acpsdk.LoadSessionRequest) (acpsdk.LoadSessionResponse, error) {
	return acpsdk.LoadSessionResponse{}, a.claim(string(req.SessionId))
}

func (a *branchWriterTestAgent) ResumeSession(_ context.Context, req acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, a.claim(string(req.SessionId))
}

func (a *branchWriterTestAgent) UnstableForkSession(_ context.Context, req acpsdk.UnstableForkSessionRequest) (acpsdk.UnstableForkSessionResponse, error) {
	if _, err := os.Stat(filepath.Join(a.dir, string(req.SessionId))); err != nil {
		return acpsdk.UnstableForkSessionResponse{}, err
	}
	id := newUUIDv4()
	return acpsdk.UnstableForkSessionResponse{SessionId: acpsdk.SessionId(id)}, a.claim(id)
}

func (a *branchWriterTestAgent) Prompt(ctx context.Context, req acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	if err := a.claim(string(req.SessionId)); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	if len(req.Prompt) > 0 && req.Prompt[0].Text != nil && req.Prompt[0].Text.Text == "hold branch" {
		if err := os.WriteFile(filepath.Join(a.dir, "branch-started"), nil, 0o600); err != nil {
			return acpsdk.PromptResponse{}, err
		}
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(filepath.Join(a.dir, "release-branch")); err == nil {
				break
			} else if !errors.Is(err, os.ErrNotExist) {
				return acpsdk.PromptResponse{}, err
			}
			select {
			case <-ctx.Done():
				return acpsdk.PromptResponse{}, ctx.Err()
			case <-ticker.C:
			}
		}
	}
	if err := a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{
		SessionId: req.SessionId, Update: acpsdk.UpdateAgentMessageText("reply for " + string(req.SessionId)),
	}); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func TestACPSourceRemainsUsableWhileBranchRuns(t *testing.T) {
	dir := t.TempDir()
	previous := acp.Providers
	acp.Providers = []acp.Provider{{
		ID: "codex", Name: "Codex",
		Prepare: func(string) (acp.Launch, error) {
			return acp.Launch{
				Command: []string{os.Args[0], "-test.run=^TestACPBranchWriterWorker$"},
				Env:     map[string]string{"LOOPRA_TEST_ACP_BRANCH_DIR": dir},
			}, nil
		},
	}}
	t.Cleanup(func() { acp.Providers = previous })
	ts, key, s, _ := parityServer(t, "")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const name = "source"
	if _, err := s.agent.Sessions.Create(ctx, createReq(s.agent, name)); err != nil {
		t.Fatal(err)
	}
	if err := s.agent.Sessions.AppendTranscript(s.agent.App(), name, []map[string]any{
		{"role": "user", "content": "earlier question"},
		{"role": "assistant", "content": "earlier answer", "acp_message_id": "answer-1"},
	}); err != nil {
		t.Fatal(err)
	}
	s.sessionMetaSet(name, map[string]any{"agentId": "codex", "title": "Original"})
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?sessionName="+name, key, nil)
	if code != http.StatusOK {
		t.Fatalf("open source = %d %v", code, env)
	}
	sourceID := strOr(s.sessionMetaRead(name), "acpSessionId", "")
	code, env = call(t, ts, http.MethodPost, "/api/sessions/"+name+"/branch?messageCount=2", key, nil)
	if code != http.StatusOK {
		t.Fatalf("branch = %d %v", code, env)
	}
	branchName := env["data"].(map[string]any)["sessionName"].(string)
	branchID := strOr(s.sessionMetaRead(branchName), "acpSessionId", "")
	if sourceID == "" || branchID == "" || sourceID == branchID {
		t.Fatalf("source and branch identities = %q, %q", sourceID, branchID)
	}

	branch := httptest.NewRecorder()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		s.runACPTurn(ctx, newSSEWriter(branch), &chatRequest{
			SessionName: branchName, AgentID: "codex", Message: "hold branch",
		}, "hold branch", false)
	}()
	defer func() {
		cancel()
		<-finished
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(filepath.Join(dir, "branch-started")); err == nil {
			break
		}
		select {
		case <-finished:
			t.Fatalf("branch stopped before prompt: %s", branch.Body.String())
		case <-ctx.Done():
			t.Fatal("branch did not start")
		case <-ticker.C:
		}
	}

	// Selecting the source reads configuration before the user sends anything.
	// This used to detach its connection and resume it in a second process,
	// which conflicted with the original writer still serving the branch.
	code, env = call(t, ts, http.MethodGet, "/api/agent-engines/config?sessionName="+name, key, nil)
	if code != http.StatusOK {
		t.Fatalf("source config while branch runs = %d %v", code, env)
	}
	source := httptest.NewRecorder()
	s.runACPTurn(ctx, newSSEWriter(source), &chatRequest{
		SessionName: name, AgentID: "codex", Message: "continue source",
	}, "continue source", false)
	if body := source.Body.String(); strings.Contains(body, "event: error") || !strings.Contains(body, "reply for "+sourceID) {
		t.Fatalf("source could not continue independently: %s", body)
	}
	select {
	case <-finished:
		t.Fatal("continuing the source interrupted the branch")
	default:
	}
	if err := os.WriteFile(filepath.Join(dir, "release-branch"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("branch did not finish")
	}
	if body := branch.Body.String(); strings.Contains(body, "event: error") || !strings.Contains(body, "reply for "+branchID) {
		t.Fatalf("branch could not continue independently: %s", body)
	}
	if got := strOr(s.sessionMetaRead(name), "acpSessionId", ""); got != sourceID {
		t.Fatalf("source identity changed to %q", got)
	}
}

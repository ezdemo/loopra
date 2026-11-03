package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// Run a real SDK peer in a child test process so HTTP and SSE exercise the
// adapter's JSON-RPC error data rather than constructing frontend errors.
func TestACPWriterWorker(t *testing.T) {
	if os.Getenv("LOOPRA_TEST_ACP_WRITER") != "1" {
		return
	}
	agent := &writerTestAgent{}
	agent.conn = acpsdk.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	<-agent.conn.Done()
	os.Exit(0)
}

type writerTestAgent struct {
	acpsdk.Agent
	conn *acpsdk.AgentSideConnection
}

func (a *writerTestAgent) Initialize(context.Context, acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	return acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		AgentCapabilities: acpsdk.AgentCapabilities{
			LoadSession: true,
			SessionCapabilities: acpsdk.SessionCapabilities{
				Resume: &acpsdk.SessionResumeCapabilities{},
				Fork:   &acpsdk.SessionForkCapabilities{},
			},
		},
	}, nil
}

func writerTestConflict(id string) error {
	if id != "remote-occupied" {
		return nil
	}
	if _, err := os.Stat(os.Getenv("LOOPRA_TEST_ACP_RELEASE")); err == nil {
		return nil
	}
	return acpsdk.NewInvalidRequest(map[string]any{
		"reason": "thread_active_writer", "threadId": id,
		"details": fmt.Sprintf("thread %s already has an active writer", id),
	})
}

func (a *writerTestAgent) LoadSession(_ context.Context, req acpsdk.LoadSessionRequest) (acpsdk.LoadSessionResponse, error) {
	return acpsdk.LoadSessionResponse{}, writerTestConflict(string(req.SessionId))
}

func (a *writerTestAgent) ResumeSession(_ context.Context, req acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, writerTestConflict(string(req.SessionId))
}

func (a *writerTestAgent) UnstableForkSession(_ context.Context, req acpsdk.UnstableForkSessionRequest) (acpsdk.UnstableForkSessionResponse, error) {
	// A fork must be able to read the source without acquiring its writer.
	if req.SessionId != "remote-occupied" {
		return acpsdk.UnstableForkSessionResponse{}, acpsdk.NewInvalidParams(nil)
	}
	return acpsdk.UnstableForkSessionResponse{SessionId: acpsdk.SessionId("remote-" + newUUIDv4())}, nil
}

func (a *writerTestAgent) SetSessionConfigOption(context.Context, acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	return acpsdk.SetSessionConfigOptionResponse{}, nil
}

func (a *writerTestAgent) Prompt(ctx context.Context, req acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	if err := writerTestConflict(string(req.SessionId)); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	if err := a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{
		SessionId: req.SessionId, Update: acpsdk.UpdateAgentMessageText("continued in fork"),
	}); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func TestACPOccupiedSessionRetryAndIndependentFork(t *testing.T) {
	previous := acp.Providers
	released := filepath.Join(t.TempDir(), "released")
	acp.Providers = []acp.Provider{{
		ID: "codex", Name: "Codex",
		Prepare: func(string) (acp.Launch, error) {
			return acp.Launch{
				Command: []string{os.Args[0], "-test.run=^TestACPWriterWorker$"},
				Env: map[string]string{
					"LOOPRA_TEST_ACP_WRITER": "1", "LOOPRA_TEST_ACP_RELEASE": released,
				},
			}, nil
		},
	}}
	t.Cleanup(func() { acp.Providers = previous })
	ts, key, s, _ := parityServer(t, "")
	const name = "occupied"
	source := []map[string]any{
		{"role": "user", "content": "earlier question"},
		{"role": "assistant", "content": "earlier answer", "acp_message_id": "answer-1"},
	}
	if _, err := s.agent.Sessions.Create(context.Background(), createReq(s.agent, name)); err != nil {
		t.Fatal(err)
	}
	if err := s.agent.Sessions.AppendTranscript(s.agent.App(), name, source); err != nil {
		t.Fatal(err)
	}
	s.sessionMetaSet(name, map[string]any{
		"agentId": "codex", "acpSessionId": "remote-occupied", "title": "Original",
		"agentConfig": map[string]any{"model": "saved-model", "effort": "high"},
	})
	assertOccupied := func(code int, env map[string]any) {
		t.Helper()
		if code != http.StatusConflict || env["reason"] != "thread_active_writer" {
			t.Fatalf("occupied response = %d %v", code, env)
		}
		if !strings.Contains(fmt.Sprint(env["error"]), "占用") {
			t.Fatalf("missing actionable message: %v", env)
		}
	}
	for _, request := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/agent-engines/config?sessionName=" + name, nil},
		{http.MethodPut, "/api/agent-engines/config", map[string]any{"sessionName": name, "configId": "model", "value": "saved-model"}},
		{http.MethodPost, "/api/agent-engines/prepare", map[string]any{"sessionName": name, "agentId": "codex"}},
	} {
		code, env := call(t, ts, request.method, request.path, key, request.body)
		assertOccupied(code, env)
	}
	before := s.sessionMessages(context.Background(), name)
	recorder := httptest.NewRecorder()
	s.runACPTurn(context.Background(), newSSEWriter(recorder), &chatRequest{
		SessionName: name, AgentID: "codex", Message: "unaccepted",
	}, "unaccepted", false)
	frames := parseSSE(t, recorder.Body.String())
	if len(frames) != 2 || frames[0]["type"] != "error" ||
		frames[0]["reason"] != "thread_active_writer" || frames[1]["type"] != "done" {
		t.Fatalf("occupied stream = %v", frames)
	}
	if after := s.sessionMessages(context.Background(), name); !reflect.DeepEqual(before, after) {
		t.Fatalf("rejected send changed source history: %v", after)
	}
	// Both the occupied notice and the existing reply action must create
	// independent remote sessions, even when requested in the same second.
	forkNames := map[string]bool{}
	for _, suffix := range []string{"/fork", "/branch?messageCount=2"} {
		code, env := call(t, ts, http.MethodPost, "/api/sessions/"+name+suffix, key, nil)
		if code != http.StatusOK {
			t.Fatalf("fork = %d %v", code, env)
		}
		data := env["data"].(map[string]any)
		forkName := data["sessionName"].(string)
		if forkName == name || forkNames[forkName] {
			t.Fatalf("fork reused a local identity: %s", forkName)
		}
		forkNames[forkName] = true
		meta := s.sessionMetaRead(forkName)
		if meta["agentId"] != "codex" || meta["acpSessionId"] == "remote-occupied" || meta["acpSessionId"] == nil {
			t.Fatalf("fork identity = %v", meta)
		}
		config := meta["agentConfig"].(map[string]any)
		if config["model"] != "saved-model" || config["effort"] != "high" {
			t.Fatalf("fork lost config = %v", meta)
		}
		if history := s.sessionMessages(context.Background(), forkName); !reflect.DeepEqual(before, history) {
			t.Fatalf("fork history = %v, source = %v", history, before)
		}
		recorder := httptest.NewRecorder()
		s.runACPTurn(context.Background(), newSSEWriter(recorder), &chatRequest{
			SessionName: forkName, AgentID: "codex", Message: "continue",
		}, "new-answer", false)
		if body := recorder.Body.String(); !strings.Contains(body, "continued in fork") || strings.Contains(body, "event: error") {
			t.Fatalf("fork could not continue: %s", body)
		}
	}
	if after := s.sessionMessages(context.Background(), name); !reflect.DeepEqual(before, after) {
		t.Fatalf("fork changed source history: %v", after)
	}
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?sessionName="+name, key, nil)
	assertOccupied(code, env)
	if err := os.WriteFile(released, []byte("released"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, env = call(t, ts, http.MethodGet, "/api/agent-engines/config?sessionName="+name, key, nil)
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("retry after release = %d %v", code, env)
	}
	// Ownership can also change after a successful configuration read. Once
	// prompt reports the conflict, retry must validate the remote session.
	if err := os.Remove(released); err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	s.runACPTurn(context.Background(), newSSEWriter(recorder), &chatRequest{
		SessionName: name, AgentID: "codex", Message: "writer changed",
	}, "writer-changed", false)
	frames = parseSSE(t, recorder.Body.String())
	if len(frames) != 2 || frames[0]["reason"] != "thread_active_writer" || frames[1]["type"] != "done" {
		t.Fatalf("prompt conflict = %v", frames)
	}
	code, env = call(t, ts, http.MethodGet, "/api/agent-engines/config?sessionName="+name, key, nil)
	assertOccupied(code, env)
}

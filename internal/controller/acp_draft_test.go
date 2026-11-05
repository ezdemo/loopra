package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// 用真实 SDK 子进程模拟只存在于进程内存中的空白 Codex 线程。
func TestACPDraftWorker(t *testing.T) {
	if os.Getenv("LOOPRA_TEST_ACP_DRAFT") != "1" {
		return
	}
	agent := &draftTestAgent{sessions: map[acpsdk.SessionId]*draftTestSession{}}
	agent.conn = acpsdk.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	<-agent.conn.Done()
	os.Exit(0)
}

type draftTestSession struct {
	model string
	dirs  []string
	cwd   string
}

type draftTestAgent struct {
	acpsdk.Agent
	conn     *acpsdk.AgentSideConnection
	mu       sync.Mutex
	sessions map[acpsdk.SessionId]*draftTestSession
	next     int
}

func (a *draftTestAgent) Initialize(context.Context, acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	return acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		AgentCapabilities: acpsdk.AgentCapabilities{
			LoadSession: true,
			SessionCapabilities: acpsdk.SessionCapabilities{
				Resume: &acpsdk.SessionResumeCapabilities{},
			},
		},
	}, nil
}

func draftOptions(model string) []acpsdk.SessionConfigOption {
	options := acpsdk.SessionConfigSelectOptionsUngrouped{
		{Value: "default-model", Name: "Default"},
		{Value: "chosen-model", Name: "Chosen"},
	}
	return []acpsdk.SessionConfigOption{{Select: &acpsdk.SessionConfigOptionSelect{
		Id: "model", Name: "Model", Type: "select", CurrentValue: acpsdk.SessionConfigValueId(model),
		Options: acpsdk.SessionConfigSelectOptions{Ungrouped: &options},
	}}}
}

func (a *draftTestAgent) NewSession(_ context.Context, req acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if os.Getenv("LOOPRA_TEST_ACP_DRAFT_REJECT_NEW") == "1" {
		return acpsdk.NewSessionResponse{}, acpsdk.NewInternalError(map[string]any{"details": "creation rejected"})
	}
	a.next++
	id := acpsdk.SessionId(fmt.Sprintf("draft-%d-%d", os.Getpid(), a.next))
	a.sessions[id] = &draftTestSession{
		model: "default-model", dirs: append([]string(nil), req.AdditionalDirectories...), cwd: req.Cwd,
	}
	return acpsdk.NewSessionResponse{SessionId: id, ConfigOptions: draftOptions("default-model")}, nil
}

func missingDraft(id acpsdk.SessionId) error {
	if id == "unrelated-error" {
		return acpsdk.NewInternalError(map[string]any{"details": "temporary backend failure"})
	}
	if id == "occupied" {
		return acpsdk.NewInvalidRequest(map[string]any{"reason": acp.ReasonThreadActiveWriter})
	}
	if id == "other-thread-error" {
		return acpsdk.NewInternalError(map[string]any{"details": "no rollout found for thread id another-thread"})
	}
	return acpsdk.NewInternalError(map[string]any{"details": "no rollout found for thread id " + string(id)})
}

func (a *draftTestAgent) LoadSession(_ context.Context, req acpsdk.LoadSessionRequest) (acpsdk.LoadSessionResponse, error) {
	return acpsdk.LoadSessionResponse{}, missingDraft(req.SessionId)
}

func (a *draftTestAgent) ResumeSession(_ context.Context, req acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, missingDraft(req.SessionId)
}

func (a *draftTestAgent) SetSessionConfigOption(_ context.Context, req acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if req.ValueId == nil || req.ValueId.ConfigId != "model" {
		return acpsdk.SetSessionConfigOptionResponse{}, acpsdk.NewInvalidParams(nil)
	}
	session := a.sessions[req.ValueId.SessionId]
	if session == nil {
		return acpsdk.SetSessionConfigOptionResponse{}, missingDraft(req.ValueId.SessionId)
	}
	session.model = string(req.ValueId.Value)
	return acpsdk.SetSessionConfigOptionResponse{ConfigOptions: draftOptions(session.model)}, nil
}

func (a *draftTestAgent) Prompt(ctx context.Context, req acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	a.mu.Lock()
	session := a.sessions[req.SessionId]
	if session == nil {
		a.mu.Unlock()
		return acpsdk.PromptResponse{}, missingDraft(req.SessionId)
	}
	text := fmt.Sprintf("model=%s;cwd=%s;dirs=%s", session.model, session.cwd, strings.Join(session.dirs, "|"))
	a.mu.Unlock()
	if err := a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{
		SessionId: req.SessionId, Update: acpsdk.UpdateAgentMessageText(text),
	}); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func useDraftAgent(t *testing.T) {
	t.Helper()
	previous := acp.Providers
	acp.Providers = []acp.Provider{{
		ID: "codex", Name: "Codex",
		Prepare: func(string) (acp.Launch, error) {
			return acp.Launch{
				Command: []string{os.Args[0], "-test.run=^TestACPDraftWorker$"},
				Env:     map[string]string{"LOOPRA_TEST_ACP_DRAFT": "1"},
			}, nil
		},
	}}
	t.Cleanup(func() { acp.Providers = previous })
}

func TestACPDraftKeepsThreadAndLinksThroughConfigAndFirstSend(t *testing.T) {
	for _, changeModel := range []bool{false, true} {
		t.Run(fmt.Sprintf("change-model=%t", changeModel), func(t *testing.T) {
			useDraftAgent(t)
			ts, key, s, home := parityServer(t, "")
			main := s.agent.App()
			linkedPath := filepath.Join(home, "linked")
			linked := addProject(t, ts, key, linkedPath)
			code, env := call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key,
				map[string]any{"linkedProjectHashes": []string{linked}})
			if code != http.StatusOK {
				t.Fatalf("save links = %d %v", code, env)
			}
			const name = "draft-with-links"
			code, env = call(t, ts, http.MethodPost, "/api/agent-engines/prepare", key,
				map[string]any{"workspaceHash": main, "sessionName": name, "agentId": "codex"})
			if code != http.StatusOK {
				t.Fatalf("prepare = %d %v", code, env)
			}
			remote := s.sessionMetaRead(name)["acpSessionId"]
			if remote == nil {
				t.Fatal("draft did not establish a remote thread")
			}
			code, env = call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+main+"&sessionName="+name, key, nil)
			if code != http.StatusOK {
				t.Fatalf("read config = %d %v", code, env)
			}
			model := "default-model"
			if changeModel {
				model = "chosen-model"
				code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
					map[string]any{"workspaceHash": main, "sessionName": name, "configId": "model", "value": model})
				if code != http.StatusOK {
					t.Fatalf("update model = %d %v", code, env)
				}
			}
			if s.sessionMetaRead(name)["acpSessionId"] != remote {
				t.Fatal("config replaced the draft thread")
			}
			content := sendDraftMessage(t, ts, key, main, name, nil)
			want := fmt.Sprintf("model=%s;cwd=%s;dirs=%s", model, s.workspaceRoot(), linkedPath)
			if content != want || s.sessionMetaRead(name)["acpSessionId"] != remote {
				t.Fatalf("first send = %q, want %q; thread %v -> %v", content, want, remote, s.sessionMetaRead(name)["acpSessionId"])
			}
		})
	}
}

func sendDraftMessage(t *testing.T, ts *httptest.Server, key, workspace, name string, links []string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"workspaceHash": workspace, "sessionName": name, "agentId": "codex", "message": "hello",
		"linkedProjectHashes": links,
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Loopra-Key", key)
	req.Header.Set("Content-Type", "application/json")
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(res.Body)
	closeErr := res.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("read SSE = %v, close = %v", readErr, closeErr)
	}
	frames := parseSSE(t, string(body))
	var content strings.Builder
	for _, frame := range frames {
		if frame["type"] == "error" {
			t.Fatalf("first send failed: %v", frame)
		}
		if token, ok := frame["content"].(string); ok && frame["type"] == "content" {
			content.WriteString(token)
		}
	}
	if res.StatusCode != http.StatusOK || len(frames) == 0 || frames[len(frames)-1]["type"] != "done" {
		t.Fatalf("incomplete SSE response: status=%d body=%s", res.StatusCode, body)
	}
	return content.String()
}

func TestACPDraftRebuildsOnFirstSendWithTemporaryLinkedProject(t *testing.T) {
	useDraftAgent(t)
	ts, key, s, home := parityServer(t, "")
	main := s.agent.App()
	linkedPath := filepath.Join(home, "temporary-linked")
	linked := addProject(t, ts, key, linkedPath)
	const name = "changed-links"
	code, env := call(t, ts, http.MethodPost, "/api/agent-engines/prepare", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "agentId": "codex"})
	if code != http.StatusOK {
		t.Fatalf("prepare = %d %v", code, env)
	}
	remote := s.sessionMetaRead(name)["acpSessionId"]
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "model", "value": "chosen-model"})
	if code != http.StatusOK {
		t.Fatalf("update model = %d %v", code, env)
	}
	content := sendDraftMessage(t, ts, key, main, name, []string{linked})
	want := fmt.Sprintf("model=chosen-model;cwd=%s;dirs=%s", s.workspaceRoot(), linkedPath)
	if content != want || s.sessionMetaRead(name)["acpSessionId"] == remote {
		t.Fatalf("rebuilt turn = %q, want %q; thread %v -> %v", content, want, remote, s.sessionMetaRead(name)["acpSessionId"])
	}
}

func TestACPMissingDraftRebuildPreservesConfigAndHistory(t *testing.T) {
	for _, tc := range []struct {
		name      string
		file      string
		content   string
		remote    string
		rejectNew bool
		wantOK    bool
	}{
		{name: "blank", wantOK: true},
		{name: "empty-log", file: ".jsonl", wantOK: true},
		{name: "history", file: ".jsonl", content: "{\"role\":\"user\",\"content\":\"keep\"}\n"},
		{name: "rolled-back", file: ".events", content: "{\"role\":\"user\",\"content\":\"keep\"}\n"},
		{name: "corrupt-history", file: ".jsonl", content: "{broken\n"},
		{name: "history-unreadable", file: ".jsonl", content: "directory"},
		{name: "unrelated-failure", remote: "unrelated-error"},
		{name: "other-thread-failure", remote: "other-thread-error"},
		{name: "writer-conflict", remote: "occupied"},
		{name: "rebuild-failure", rejectNew: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			useDraftAgent(t)
			if tc.rejectNew {
				t.Setenv("LOOPRA_TEST_ACP_DRAFT_REJECT_NEW", "1")
			}
			ts, key, s, _ := parityServer(t, "")
			const name = "lost-draft"
			remote := tc.remote
			if remote == "" {
				remote = "lost-remote"
			}
			s.sessionMetaSet(name, map[string]any{
				"agentId": "codex", "acpSessionId": remote,
				"agentConfig": map[string]any{"model": "chosen-model"}, "futureField": "keep",
			})
			if tc.file != "" {
				path := filepath.Join(s.sessionDir(), name+tc.file)
				if tc.content == "directory" {
					if err := os.Mkdir(path, 0o700); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			before := s.sessionMetaRead(name)
			code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?sessionName="+name, key, nil)
			after := s.sessionMetaRead(name)
			if tc.wantOK {
				if code != http.StatusOK || after["acpSessionId"] == remote ||
					!reflect.DeepEqual(after["agentConfig"], before["agentConfig"]) || after["futureField"] != "keep" {
					t.Fatalf("rebuild = %d %v, meta = %v", code, env, after)
				}
				options := env["data"].(map[string]any)["configOptions"].([]any)
				if options[0].(map[string]any)["currentValue"] != "chosen-model" {
					t.Fatalf("model not restored: %v", options)
				}
			} else if code == http.StatusOK || !reflect.DeepEqual(before, after) {
				t.Fatalf("failed recovery replaced history/binding: %d %v, before=%v, after=%v", code, env, before, after)
			}
			if tc.file != "" && tc.content != "directory" {
				raw, err := os.ReadFile(filepath.Join(s.sessionDir(), name+tc.file))
				if err != nil || string(raw) != tc.content {
					t.Fatalf("history changed: %q %v", raw, err)
				}
			}
		})
	}
}

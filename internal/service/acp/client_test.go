package acp

import (
	"context"
	"os"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// TestMain 让测试二进制在设置环境变量时充当一个脚本化的 ACP Agent，
// 以便端到端验证 stdio 传输与事件映射，不依赖外部 node 适配器。
func TestMain(m *testing.M) {
	if os.Getenv("LOOPRA_ACP_FAKE") == "1" {
		fakeAgent()
		return
	}
	os.Exit(m.Run())
}

// fakeAgent 用 SDK 实现一个最小 ACP Agent，验证客户端能收到同一套更新。
func fakeAgent() {
	agent := &fakeSDKAgent{}
	conn := acpsdk.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	agent.conn = conn
	<-conn.Done()
}

type fakeSDKAgent struct {
	conn *acpsdk.AgentSideConnection
}

func (a *fakeSDKAgent) Authenticate(context.Context, acpsdk.AuthenticateRequest) (acpsdk.AuthenticateResponse, error) {
	return acpsdk.AuthenticateResponse{}, nil
}

func (a *fakeSDKAgent) Initialize(context.Context, acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	return acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		AgentCapabilities: acpsdk.AgentCapabilities{
			LoadSession: true,
			Meta:        map[string]any{"loopra.dev/workbench": true},
		},
		AgentInfo: &acpsdk.Implementation{Name: "fake", Title: acpsdk.Ptr("Fake")},
	}, nil
}

func (a *fakeSDKAgent) Logout(context.Context, acpsdk.LogoutRequest) (acpsdk.LogoutResponse, error) {
	return acpsdk.LogoutResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodLogout)
}

func (a *fakeSDKAgent) Cancel(context.Context, acpsdk.CancelNotification) error { return nil }

func (a *fakeSDKAgent) CloseSession(context.Context, acpsdk.CloseSessionRequest) (acpsdk.CloseSessionResponse, error) {
	return acpsdk.CloseSessionResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionClose)
}

func (a *fakeSDKAgent) ListSessions(context.Context, acpsdk.ListSessionsRequest) (acpsdk.ListSessionsResponse, error) {
	return acpsdk.ListSessionsResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionList)
}

func (a *fakeSDKAgent) NewSession(context.Context, acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	return acpsdk.NewSessionResponse{
		SessionId: "fake-session",
		Modes: &acpsdk.SessionModeState{
			CurrentModeId: "auto",
			AvailableModes: []acpsdk.SessionMode{
				{Id: "auto", Name: "Auto"},
				{Id: "default", Name: "Manual"},
			},
		},
	}, nil
}

func (a *fakeSDKAgent) Prompt(ctx context.Context, _ acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	sid := acpsdk.SessionId("fake-session")
	send := func(update acpsdk.SessionUpdate) {
		_ = a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{SessionId: sid, Update: update})
	}
	send(acpsdk.UpdateAgentThoughtText("想一下"))
	send(acpsdk.UpdateAgentMessageText("答复"))
	send(acpsdk.StartToolCall("call-1", "Read",
		acpsdk.WithStartStatus(acpsdk.ToolCallStatusInProgress),
		acpsdk.WithStartRawInput(map[string]any{"path": "a.txt"}),
	))
	send(acpsdk.UpdateToolCall("call-1",
		acpsdk.WithUpdateStatus(acpsdk.ToolCallStatusCompleted),
		acpsdk.WithUpdateContent([]acpsdk.ToolCallContent{
			acpsdk.ToolContent(acpsdk.TextBlock("file body")),
			acpsdk.ToolDiffContent("a.txt", "new\n", "old\n"),
		}),
	))
	send(acpsdk.SessionUpdate{UsageUpdate: &acpsdk.SessionUsageUpdate{Used: 12, Size: 100}})
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func (a *fakeSDKAgent) ResumeSession(context.Context, acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionResume)
}

func (a *fakeSDKAgent) SetSessionConfigOption(context.Context, acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	return acpsdk.SetSessionConfigOptionResponse{ConfigOptions: []acpsdk.SessionConfigOption{}}, nil
}

func (a *fakeSDKAgent) SetSessionMode(context.Context, acpsdk.SetSessionModeRequest) (acpsdk.SetSessionModeResponse, error) {
	return acpsdk.SetSessionModeResponse{}, nil
}

func fakeClient(t *testing.T, handler Handler) *Client {
	t.Helper()
	client, err := NewClient(Launch{
		Command: []string{os.Args[0], "-test.run=TestMain"},
		Env:     map[string]string{"LOOPRA_ACP_FAKE": "1"},
	}, t.TempDir(), handler, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestClientSessionFlow(t *testing.T) {
	var events []Event
	client := fakeClient(t, func(event Event) {
		events = append(events, event)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	if !client.NativeEvents() {
		t.Fatal("loopra.dev/workbench capability should be detected")
	}
	setup, err := client.NewSession(ctx, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if setup.SessionID != "fake-session" {
		t.Fatalf("session id = %q", setup.SessionID)
	}
	options := client.ConfigOptions()
	if len(options) != 1 || options[0].ID != "mode" || options[0].CurrentValue != "auto" {
		t.Fatalf("legacy config options = %+v", options)
	}
	result, err := client.Prompt(ctx, []ContentBlock{{Type: "text", Text: "hi"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.StopReason != "end_turn" {
		t.Fatalf("stop reason = %q", result.StopReason)
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(events) < 5 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	kinds := make([]EventKind, 0, len(events))
	for _, event := range events {
		kinds = append(kinds, event.Kind)
	}
	want := []EventKind{EventReason, EventContent, EventToolCall, EventToolCall, EventUsage}
	if len(events) != len(want) {
		t.Fatalf("events = %v", kinds)
	}
	for i, kind := range want {
		if events[i].Kind != kind {
			t.Fatalf("event %d = %v, want %v", i, events[i].Kind, kind)
		}
	}
	if events[0].Text != "想一下" || events[1].Text != "答复" {
		t.Fatalf("deltas = %+v / %+v", events[0], events[1])
	}
	if events[2].Tool == nil || events[2].Tool.ToolCallID != "call-1" {
		t.Fatalf("tool call = %+v", events[2].Tool)
	}
	if events[3].Tool == nil || events[3].Tool.Status != "completed" {
		t.Fatalf("tool update = %+v", events[3].Tool)
	}
	if items := events[3].Tool.ToolContent(); len(items) != 2 || items[1].Type != "diff" {
		t.Fatalf("tool content = %+v", items)
	}
	if events[4].Used != 12 || events[4].Size != 100 {
		t.Fatalf("usage = %+v", events[4])
	}
}

func TestSupportedMCPSkipsUndeclaredHTTP(t *testing.T) {
	servers := []any{
		map[string]any{"type": "http", "name": "context7", "url": "https://mcp.context7.com/mcp"},
		map[string]any{"name": "local", "command": "echo"},
	}
	skipped := supportedMCP(AgentCapabilities{}, servers)
	if len(skipped) != 1 || skipped[0].(map[string]any)["name"] != "local" {
		t.Fatalf("skipped = %#v", skipped)
	}
	kept := supportedMCP(AgentCapabilities{MCPCapabilities: map[string]any{"http": true}}, servers)
	if len(kept) != 2 {
		t.Fatalf("kept = %#v", kept)
	}
}

func TestCompareFile(t *testing.T) {
	oldText := "a\nb\nc\n"
	change := CompareFile("x.txt", &oldText, "a\nB\nc\nd\n")
	if change.Path != "x.txt" || change.Created {
		t.Fatalf("change = %+v", change)
	}
	if change.Additions != 2 || change.Deletions != 1 {
		t.Fatalf("additions/deletions = %d/%d", change.Additions, change.Deletions)
	}
	created := CompareFile("new.txt", nil, "hello\n")
	if !created.Created || created.Additions != 1 {
		t.Fatalf("created = %+v", created)
	}
}

func TestProviderDetectionHonorsOverrides(t *testing.T) {
	dir := t.TempDir()
	node := dir + string(os.PathSeparator) + "node"
	adapter := dir + string(os.PathSeparator) + "adapter.js"
	claude := dir + string(os.PathSeparator) + "claude"
	for _, path := range []string{node, adapter, claude} {
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("LOOPRA_NODE_EXECUTABLE", node)
	t.Setenv("LOOPRA_CLAUDE_ACP_SCRIPT", adapter)
	t.Setenv("CLAUDE_CODE_EXECUTABLE", claude)
	availability := detectClaude()
	if !availability.Available {
		t.Fatalf("availability = %+v", availability)
	}
	launch, err := prepareClaude(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(launch.Command) != 2 || launch.Command[1] != adapter || launch.Env["CLAUDE_CODE_EXECUTABLE"] != claude {
		t.Fatalf("launch = %+v", launch)
	}
}

func TestWithLoopbackHosts(t *testing.T) {
	if got := withLoopbackHosts(""); got != "127.0.0.1,localhost,::1" {
		t.Fatalf("empty no_proxy = %q", got)
	}
	if got := withLoopbackHosts("example.com, localhost"); got != "example.com,localhost,127.0.0.1,::1" {
		t.Fatalf("merged no_proxy = %q", got)
	}
	if got := withLoopbackHosts("*"); got != "*" {
		t.Fatalf("wildcard no_proxy = %q", got)
	}
}

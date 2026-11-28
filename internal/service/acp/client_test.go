package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
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
	var output io.Writer = os.Stdout
	if os.Getenv("LOOPRA_ACP_FAKE_META_LOG") != "" {
		agent.workflowResponse = make(chan struct{}, 1)
		output = fakeWorkflowResponseWriter{Writer: output, wrotePrompt: agent.workflowResponse}
	}
	conn := acpsdk.NewAgentSideConnection(agent, output, os.Stdin)
	agent.conn = conn
	<-conn.Done()
}

// fakeWorkflowResponseWriter 观察 SDK 写出的帧，把 session/prompt 的
// end_turn 响应落线时刻通知给 workflowFollowup。
type fakeWorkflowResponseWriter struct {
	io.Writer
	wrotePrompt chan<- struct{}
}

func (w fakeWorkflowResponseWriter) Write(data []byte) (int, error) {
	n, err := w.Writer.Write(data)
	if err == nil && bytes.Contains(data, []byte(`"result":{"stopReason":"end_turn"`)) {
		select {
		case w.wrotePrompt <- struct{}{}:
		default:
		}
	}
	return n, err
}

type fakeSDKAgent struct {
	conn             *acpsdk.AgentSideConnection
	workflowResponse chan struct{}
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

func (a *fakeSDKAgent) NewSession(_ context.Context, req acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	// LOOPRA_ACP_FAKE_META_LOG 逐行记录 session/new 收到的 _meta，
	// 供 Claude Workflow 订阅测试断言 emitRawSDKMessages 过滤器。
	if log := os.Getenv("LOOPRA_ACP_FAKE_META_LOG"); log != "" {
		if data, err := json.Marshal(req.Meta); err == nil {
			if file, openErr := os.OpenFile(log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); openErr == nil {
				_, _ = file.Write(append(data, '\n'))
				_ = file.Close()
			}
		}
	}
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

func (a *fakeSDKAgent) Prompt(ctx context.Context, req acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	// LOOPRA_ACP_FAKE_PROMPT_LOG 按顺序原样记录每次提示词的全部文本块，
	// 供历史交接测试断言实际发送内容；LOOPRA_ACP_FAKE_FAIL 指向的文件存在时
	// 注入一次可重试的发送失败。
	if log := os.Getenv("LOOPRA_ACP_FAKE_PROMPT_LOG"); log != "" {
		var text strings.Builder
		for _, block := range req.Prompt {
			if block.Text == nil {
				continue
			}
			text.WriteString(block.Text.Text)
		}
		text.WriteString("\n---\n")
		file, err := os.OpenFile(log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err == nil {
			_, err = file.WriteString(text.String())
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
		}
		if err != nil {
			return acpsdk.PromptResponse{}, err
		}
	}
	if fail := os.Getenv("LOOPRA_ACP_FAKE_FAIL"); fail != "" {
		if _, err := os.Stat(fail); err == nil {
			return acpsdk.PromptResponse{}, errors.New("injected prompt failure")
		}
	}
	// LOOPRA_ACP_FAKE_WAIT_CANCEL 让提示词停在已记录状态直到请求取消，
	// 供种子标记的取消路径测试使用。
	if os.Getenv("LOOPRA_ACP_FAKE_WAIT_CANCEL") != "" {
		<-ctx.Done()
		return acpsdk.PromptResponse{}, ctx.Err()
	}
	sid := acpsdk.SessionId("fake-session")
	send := func(update acpsdk.SessionUpdate) {
		_ = a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{SessionId: sid, Update: update})
	}
	if len(req.Prompt) > 0 && req.Prompt[0].Text != nil && req.Prompt[0].Text.Text == "burst" {
		send(acpsdk.StartToolCall("burst-tool", "Shell", acpsdk.WithStartStatus(acpsdk.ToolCallStatusInProgress)))
		for i := 0; i < 4096; i++ {
			update := acpsdk.UpdateToolCall("burst-tool")
			update.ToolCallUpdate.Meta = map[string]any{"terminal_output_delta": map[string]any{"data": strings.Repeat("x", 128)}}
			send(update)
		}
		send(acpsdk.UpdateToolCall("burst-tool", acpsdk.WithUpdateStatus(acpsdk.ToolCallStatusCompleted),
			acpsdk.WithUpdateRawOutput(map[string]any{"exit_code": 0})))
		send(acpsdk.UpdateAgentMessageText("done"))
		return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
	}
	if len(req.Prompt) > 0 && req.Prompt[0].Text != nil && req.Prompt[0].Text.Text == "workflow" {
		// Claude Code 后台 Workflow：回合先 end_turn，适配器随后以原始
		// SDK 消息唤醒同一轮——接续过程走标准 ACP 输出与权限请求。
		raw := func(message map[string]any) {
			_ = a.conn.NotifyExtension(ctx, claudeWorkflowMethod, map[string]any{
				"sessionId": string(sid), "message": message,
			})
		}
		raw(map[string]any{
			"type": "system", "subtype": "task_started", "task_type": "local_workflow",
			"task_id": "wf-task", "run_id": "run-1", "is_backgrounded": true,
		})
		send(acpsdk.UpdateAgentMessageText("workflow 前置答复"))
		go a.workflowFollowup(sid)
		return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
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

// workflowFollowup 复刻 Claude Code 的 Workflow 接续：等 end_turn 响应真正
// 写回客户端后再推任务终态、唤醒与工具调用，随后发起一次标准 ACP 权限
// 请求，获准后补上工具结果、正文与非占位 result 消息。
func (a *fakeSDKAgent) workflowFollowup(sid acpsdk.SessionId) {
	if a.workflowResponse != nil {
		select {
		case <-a.workflowResponse:
		case <-a.conn.Done():
			return
		}
	}
	ctx := context.Background()
	raw := func(message map[string]any) {
		_ = a.conn.NotifyExtension(ctx, claudeWorkflowMethod, map[string]any{
			"sessionId": string(sid), "message": message,
		})
	}
	send := func(update acpsdk.SessionUpdate) {
		_ = a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{SessionId: sid, Update: update})
	}
	raw(map[string]any{
		"type": "system", "subtype": "task_notification",
		"task_id": "wf-task", "run_id": "run-1", "status": "completed",
	})
	raw(map[string]any{
		"type":   "user",
		"origin": map[string]any{"kind": "task-notification", "runId": "run-1"},
	})
	send(acpsdk.StartToolCall("wf-call", "Shell",
		acpsdk.WithStartStatus(acpsdk.ToolCallStatusInProgress),
		acpsdk.WithStartRawInput(map[string]any{"command": "ls"})))
	resp, err := a.conn.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
		SessionId: sid,
		ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "wf-call", Title: acpsdk.Ptr("Shell")},
		Options:   []acpsdk.PermissionOption{{OptionId: "allow", Name: "Allow", Kind: "allow_once"}},
	})
	if err != nil || resp.Outcome.Selected == nil {
		return
	}
	send(acpsdk.UpdateToolCall("wf-call",
		acpsdk.WithUpdateStatus(acpsdk.ToolCallStatusCompleted),
		acpsdk.WithUpdateRawOutput(map[string]any{"exit_code": 0})))
	send(acpsdk.UpdateAgentMessageText("workflow 后续答复"))
	raw(map[string]any{
		"type": "result", "num_turns": 1,
		"origin": map[string]any{"kind": "task-notification", "runId": "run-1"},
	})
}

func (a *fakeSDKAgent) ResumeSession(context.Context, acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionResume)
}

func (a *fakeSDKAgent) SetSessionConfigOption(_ context.Context, req acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	// LOOPRA_ACP_FAKE_CONFIG_LOG 记录请求自带的 sessionId/configId，
	// 供共享进程配置隔离测试断言 RPC 落在哪个远端会话上；此时按 v1 语义回
	// 完整快照（配置项取请求值），验证回包归位而不是靠缺省字段兜底。
	if log := os.Getenv("LOOPRA_ACP_FAKE_CONFIG_LOG"); log != "" {
		var sessionID, configID, value string
		if req.ValueId != nil {
			sessionID, configID, value = string(req.ValueId.SessionId), string(req.ValueId.ConfigId), string(req.ValueId.Value)
		} else if req.Boolean != nil {
			sessionID, configID = string(req.Boolean.SessionId), string(req.Boolean.ConfigId)
			if req.Boolean.Value {
				value = "true"
			} else {
				value = "false"
			}
		}
		if file, err := os.OpenFile(log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			_, _ = file.WriteString(sessionID + "|" + configID + "|" + value + "\n")
			_ = file.Close()
		}
		option := acpsdk.NewSessionConfigOptionSelect(acpsdk.SessionConfigValueId(value),
			acpsdk.SessionConfigSelectOptions{Ungrouped: &acpsdk.SessionConfigSelectOptionsUngrouped{
				{Value: acpsdk.SessionConfigValueId(value), Name: value},
			}})
		option.Select.Id = acpsdk.SessionConfigId(configID)
		option.Select.Name = configID
		return acpsdk.SetSessionConfigOptionResponse{ConfigOptions: []acpsdk.SessionConfigOption{option}}, nil
	}
	return acpsdk.SetSessionConfigOptionResponse{}, nil
}

func (a *fakeSDKAgent) SetSessionMode(context.Context, acpsdk.SetSessionModeRequest) (acpsdk.SetSessionModeResponse, error) {
	return acpsdk.SetSessionModeResponse{}, nil
}

func fakeClient(t *testing.T, handler Handler) *Client {
	return fakeClientEnv(t, handler, nil)
}

func fakeClientEnv(t *testing.T, handler Handler, env map[string]string) *Client {
	t.Helper()
	vars := map[string]string{"LOOPRA_ACP_FAKE": "1"}
	for key, value := range env {
		vars[key] = value
	}
	client, err := NewClient(Launch{
		Command: []string{os.Args[0], "-test.run=TestMain"},
		Env:     vars,
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

// TestConnSetConfigOptionStaysOnOwnSession 覆盖共享进程的配置隔离：
// 两个 Loopra 会话复用一条连接，focus 停在 B 上时修改 A——RPC 必须带
// A 的 sessionId，回包只写进 A 的快照，B 与客户端全局快照都不能动。
func TestConnSetConfigOptionStaysOnOwnSession(t *testing.T) {
	log := t.TempDir() + "/config.log"
	client := fakeClientEnv(t, nil, map[string]string{"LOOPRA_ACP_FAKE_CONFIG_LOG": log})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	connA := &Conn{name: "a", client: client, acpSession: "ses-a", state: newACPSharedState()}
	connB := &Conn{name: "b", client: client, acpSession: "ses-b", state: newACPSharedState()}
	connA.BindSession("ses-a", []ConfigOption{{ID: "mode", Type: "select", CurrentValue: "agent"}})
	connB.BindSession("ses-b", []ConfigOption{{ID: "mode", Type: "select", CurrentValue: "agent"}})
	// owner / 全局 sessionID 停在 B 上：修改 A 不能跟错人。
	connB.Use()

	options, err := connA.SetConfigOption(ctx, "mode", "full")
	if err != nil {
		t.Fatal(err)
	}
	if got := options[0].CurrentValue; got != "full" {
		t.Fatalf("options = %+v", options)
	}
	if got := connA.ConfigOptions()[0].CurrentValue; got != "full" {
		t.Fatalf("connA options = %+v", connA.ConfigOptions())
	}
	if got := connB.ConfigOptions()[0].CurrentValue; got != "agent" {
		t.Fatalf("B 的快照被 A 的修改污染: %+v", connB.ConfigOptions())
	}
	body, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "ses-a|mode|full\n" {
		t.Fatalf("config log = %q", body)
	}
	// 客户端全局快照仍属于 B（c.sessionID==ses-b），A 的回包不能写进去。
	if got := client.SessionID(); got != "ses-b" {
		t.Fatalf("client session = %q", got)
	}
	for _, option := range client.ConfigOptions() {
		if option.ID == "mode" && option.CurrentValue == "full" {
			t.Fatalf("client 全局快照被 A 的修改污染: %+v", client.ConfigOptions())
		}
	}
}

// TestConfigFromSDKDistinguishesEmptyFromOmitted 覆盖 v1 兼容性：字段缺省
// （旧版 Agent）与显式 "configOptions":[]（支持但当前没有可选项）必须区分。
func TestConfigFromSDKDistinguishesEmptyFromOmitted(t *testing.T) {
	if got := configFromSDK(nil); got != nil {
		t.Fatalf("omitted must stay nil: %#v", got)
	}
	if got := configFromSDK([]acpsdk.SessionConfigOption{}); got == nil || len(got) != 0 {
		t.Fatalf("explicit empty must survive: %#v", got)
	}
	// 线上反序列化路径同样要区分。
	var emptyWire acpsdk.SetSessionConfigOptionResponse
	if err := json.Unmarshal([]byte(`{"configOptions":[]}`), &emptyWire); err != nil {
		t.Fatal(err)
	}
	if got := configFromSDK(emptyWire.ConfigOptions); got == nil || len(got) != 0 {
		t.Fatalf("wire explicit empty must survive: %#v", got)
	}
	var omittedWire acpsdk.SetSessionConfigOptionResponse
	if err := json.Unmarshal([]byte(`{}`), &omittedWire); err != nil {
		t.Fatal(err)
	}
	if omittedWire.ConfigOptions != nil {
		t.Fatalf("omitted field must stay nil: %#v", omittedWire.ConfigOptions)
	}

	// applySetup：显式空列表算支持 configOptions，不回落 legacy modes 合成。
	client := &Client{children: map[string]bool{}}
	client.applySetup(&SessionSetupResult{SessionID: "ses-empty", ConfigOptions: []ConfigOption{}})
	if !client.ConfigOptionsSupported() {
		t.Fatal("explicit empty configOptions should still count as supported")
	}
	if got := client.ConfigOptions(); got == nil || len(got) != 0 {
		t.Fatalf("client snapshot should keep explicit empty: %#v", got)
	}
}

// TestApplySetupBindsToSetupOwner 覆盖建立 RPC 期间 owner 被切走的场景：
// beginAccept 记下的属主才是回绑目标，中途 focus 到 B 不能把建好的
// 配置抄到 B 名下。
func TestApplySetupBindsToSetupOwner(t *testing.T) {
	client := &Client{children: map[string]bool{}}
	connA := &Conn{name: "a", client: client, state: newACPSharedState()}
	connB := &Conn{name: "b", client: client, acpSession: "ses-b", state: newACPSharedState()}
	client.indexSession("ses-b", connB)
	client.beginAccept(connA)
	// 建立 RPC 在飞时另一个会话抢到进程（等价于 Conn.Use）。
	client.focus(connB, "ses-b")

	result := SessionSetupResult{
		SessionID:     "ses-a",
		ConfigOptions: []ConfigOption{{ID: "mode", Type: "select", CurrentValue: "agent"}},
	}
	client.applySetup(&result)

	if got := connA.SessionID(); got != "ses-a" {
		t.Fatalf("connA session = %q", got)
	}
	if got := connA.ConfigOptions(); len(got) != 1 || got[0].CurrentValue != "agent" {
		t.Fatalf("connA options = %+v", got)
	}
	if got := connB.SessionID(); got != "ses-b" {
		t.Fatalf("B 的会话 id 被 A 的建立结果覆盖: %q", got)
	}
	if got := connB.ConfigOptions(); len(got) != 0 {
		t.Fatalf("B 的配置被 A 的建立结果污染: %+v", got)
	}
	client.endAccept("ses-a")
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

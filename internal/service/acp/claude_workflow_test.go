package acp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/service/hitl"
)

// workflowHost 记录转录行并持有真实审批注册表，供 Workflow 接续测试
// 断言「经 hitl 注册的权限请求仍归属本会话」。
type workflowHost struct {
	streamHost
	perms *hitl.Registry
}

func (h *workflowHost) Permissions() *hitl.Registry { return h.perms }

func claudeWorkflowMsg(kind string, fields map[string]any) claudeWorkflowMessage {
	data, err := json.Marshal(fields)
	if err != nil {
		panic(err)
	}
	var message claudeWorkflowMessage
	if err := json.Unmarshal(data, &message); err != nil {
		panic(err)
	}
	message.Type = kind
	return message
}

func claudeWorkflowTaskStarted(taskID, runID string) claudeWorkflowMessage {
	return claudeWorkflowMsg("system", map[string]any{
		"subtype": "task_started", "task_type": "local_workflow",
		"task_id": taskID, "run_id": runID, "is_backgrounded": true,
	})
}

func claudeWorkflowNotified(taskID, runID, status string) claudeWorkflowMessage {
	return claudeWorkflowMsg("system", map[string]any{
		"subtype": "task_notification", "task_id": taskID, "run_id": runID, "status": status,
	})
}

func claudeWorkflowContinuation(kind, runID string, fields map[string]any) claudeWorkflowMessage {
	if fields == nil {
		fields = map[string]any{}
	}
	origin := map[string]any{"kind": "task-notification"}
	if runID != "" {
		origin["runId"] = runID
	}
	fields["origin"] = origin
	return claudeWorkflowMsg(kind, fields)
}

func claudeWorkflowPending(w *claudeWorkflowWait, now time.Time) (int, bool) {
	count, _, failed := w.pending(now, now.Add(claudeWorkflowWaitLimit))
	return count, failed
}

// TestRunTurnWaitsForClaudeWorkflowFollowup 驱动真实 SDK 链路：Claude Code
// 回合 end_turn 时仍有后台 Workflow，轮次保持打开直到接续的 result 到达；
// 期间的普通正文、工具更新与权限请求走既有 live turn。
func TestRunTurnWaitsForClaudeWorkflowFollowup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	metaLog := filepath.Join(t.TempDir(), "meta.log")
	host := &workflowHost{
		streamHost: streamHost{reuseHost: reuseHost{app: "test", workspace: t.TempDir()}, dir: t.TempDir()},
		perms:      hitl.NewRegistry(),
	}
	client := fakeClientEnv(t, nil, map[string]string{"LOOPRA_ACP_FAKE_META_LOG": metaLog})
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	client.claudeWorkflows = true
	setup, err := client.NewSession(ctx, host.workspace, nil)
	if err != nil {
		t.Fatal(err)
	}

	// session/new 的 _meta.claudeCode 必须携带 emitRawSDKMessages 过滤器。
	data, err := os.ReadFile(metaLog)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		ClaudeCode struct {
			Filters []map[string]string `json:"emitRawSDKMessages"`
		} `json:"claudeCode"`
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	wantFilters := []map[string]string{
		{"type": "system", "subtype": "task_started"},
		{"type": "system", "subtype": "task_notification"},
		{"type": "user", "origin": "task-notification"},
		{"type": "result", "origin": "task-notification"},
	}
	if !reflect.DeepEqual(meta.ClaudeCode.Filters, wantFilters) {
		t.Fatalf("emitRawSDKMessages = %v", meta.ClaudeCode.Filters)
	}

	conn := &Conn{
		name: "s", agentID: "claude-code", cwd: host.workspace, client: client,
		acpSession: setup.SessionID, live: true, state: newACPSharedState(),
	}
	manager := NewManager()
	manager.put(manager.key(host, "s"), conn)
	sink := &probeSink{notify: make(chan string, 256)}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		manager.RunTurn(ctx, host, sink, TurnInput{
			Session: "s", AgentID: "claude-code", Message: "workflow",
		}, "msg", false, "test")
	}()

	// Workflow 接续里的权限请求必须经 hitl 登记到本会话；等待审批期间
	// 轮次不能提前 complete/done。
	choice := sink.waitFor("choice", 15*time.Second)
	if choice == nil {
		t.Fatalf("workflow 接续的审批没有出现；seen=%v", sinkEvents(sink))
	}
	select {
	case <-finished:
		t.Fatal("审批待决期间轮次提前结束")
	default:
	}
	for _, typ := range sinkEvents(sink) {
		if typ == "complete" || typ == "done" {
			t.Fatalf("等待审批期间出现终止事件: %v", sinkEvents(sink))
		}
	}
	pends := host.perms.Pending("s")
	if len(pends) != 1 || pends[0].Session != "s" {
		t.Fatalf("pending approvals = %#v", pends)
	}
	id, _ := choice["permissionRequestId"].(string)
	if err := host.perms.Resolve(id, "s", "allow"); err != nil {
		t.Fatalf("resolve: %v", err)
	}

	complete := sink.waitFor("complete", 15*time.Second)
	if complete == nil {
		t.Fatalf("workflow 接续后轮次没有完成；seen=%v", sinkEvents(sink))
	}
	if complete["stopReason"] != "end_turn" || complete["status"] != "completed" {
		t.Fatalf("complete = %v", complete)
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("RunTurn 未在轮次收尾后返回")
	}

	sink.mu.Lock()
	var texts []string
	for _, payload := range sink.raw {
		if text, ok := payload["text"].(string); ok {
			texts = append(texts, text)
		}
	}
	seen := append([]string(nil), sink.events...)
	sink.mu.Unlock()
	joined := strings.Join(texts, "")
	if !strings.Contains(joined, "前置答复") || !strings.Contains(joined, "后续答复") {
		t.Fatalf("正文没有全部送达: %q", joined)
	}
	if n := len(seen); n < 2 || seen[n-2] != "complete" || seen[n-1] != "done" {
		t.Fatalf("终止事件 = %v", seen)
	}

	// 转录只有原始用户消息与接续产出：raw user 唤醒是内部消息，不落盘。
	host.mu.Lock()
	defer host.mu.Unlock()
	users, tools := 0, 0
	var assistant string
	for _, line := range host.lines {
		switch line["role"] {
		case "user":
			users++
			if line["content"] != "workflow" {
				t.Fatalf("出现额外的用户行: %v", line)
			}
		case "tool":
			tools++
		case "assistant":
			if text, ok := line["content"].(string); ok {
				assistant += text
			}
		}
	}
	if users != 1 || tools != 1 {
		t.Fatalf("transcript users=%d tools=%d", users, tools)
	}
	if !strings.Contains(assistant, "前置答复") || !strings.Contains(assistant, "后续答复") {
		t.Fatalf("transcript assistant = %q", assistant)
	}
}

// TestClaudeWorkflowWaitLifecycle 用假时钟覆盖跟踪器状态机：两个不同
// run、占位/无关/重复的终态不结束任务、取消等待、过期的未接续终态。
func TestClaudeWorkflowWaitLifecycle(t *testing.T) {
	now := time.Now()
	deadline := now.Add(claudeWorkflowWaitLimit)
	w := newClaudeWorkflowWait()
	w.observe(claudeWorkflowTaskStarted("t1", "r1"), now)
	w.observe(claudeWorkflowTaskStarted("t2", "r2"), now)
	if count, _ := claudeWorkflowPending(w, now); count != 2 {
		t.Fatalf("pending = %d", count)
	}

	w.observe(claudeWorkflowNotified("t1", "r1", "completed"), now)
	// 无关 run id 的 result 不结束任何任务。
	w.observe(claudeWorkflowContinuation("result", "rX", map[string]any{"num_turns": 2}), now)
	// 占位 result（0 轮且无错误）不是终态。
	w.observe(claudeWorkflowContinuation("result", "r1", map[string]any{"num_turns": 0}), now)
	if count, _ := claudeWorkflowPending(w, now); count != 2 {
		t.Fatalf("无关与占位 result 改变了 pending = %d", count)
	}

	// t1 的接续：user 唤醒标记 continuing，非占位 result 结束任务。
	w.observe(claudeWorkflowContinuation("user", "r1", nil), now)
	w.observe(claudeWorkflowContinuation("result", "r1", map[string]any{"num_turns": 1}), now)
	if count, _ := claudeWorkflowPending(w, now); count != 1 {
		t.Fatalf("t1 结束后 pending = %d", count)
	}
	// 已结束任务的重复终态是幂等的。
	w.observe(claudeWorkflowContinuation("result", "r1", map[string]any{"num_turns": 1}), now)
	if count, failed := claudeWorkflowPending(w, now); count != 1 || failed {
		t.Fatalf("重复 result 后 pending = %d failed=%v", count, failed)
	}

	// 未接续的终态在宽限期后过期：先确认宽限期内仍等待。
	w.observe(claudeWorkflowNotified("t2", "r2", "completed"), now)
	if count, _, _ := w.pending(now.Add(30*time.Second), deadline); count != 1 {
		t.Fatalf("宽限期内 pending = %d", count)
	}
	if count, _, _ := w.pending(now.Add(claudeWorkflowNotifyGrace+time.Second), deadline); count != 0 {
		t.Fatalf("过期后 pending = %d", count)
	}
}

func TestClaudeWorkflowWaitCancelAndFailure(t *testing.T) {
	never := make(chan struct{})
	// 没有任何 Workflow 的轮次立即放行。
	if err := newClaudeWorkflowWait().wait(context.Background(), never); err != nil {
		t.Fatalf("empty wait = %v", err)
	}

	// Workflow 仍在进行时取消等待，返回 ctx 错误而不是假装结束。
	w := newClaudeWorkflowWait()
	w.observe(claudeWorkflowTaskStarted("t1", "r1"), time.Now())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.wait(ctx, never) }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled wait = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("取消没有解除等待")
	}

	// 接续 result 带 is_error：全部任务结束后按 Workflow 失败收尾。
	w = newClaudeWorkflowWait()
	now := time.Now()
	w.observe(claudeWorkflowTaskStarted("t1", "r1"), now)
	w.observe(claudeWorkflowNotified("t1", "r1", "failed"), now)
	w.observe(claudeWorkflowContinuation("user", "r1", nil), now)
	w.observe(claudeWorkflowContinuation("result", "r1", map[string]any{"num_turns": 1, "is_error": true}), now)
	if err := w.wait(context.Background(), never); !errors.Is(err, errClaudeWorkflowFailed) {
		t.Fatalf("failed workflow wait = %v", err)
	}
}

// TestClaudeWorkflowExtensionRouting 覆盖扩展通知的路由边界：陌生方法、
// 坏参数、陌生远端会话、重放中的会话建立、非 Claude 轮次（无跟踪器）。
func TestClaudeWorkflowExtensionRouting(t *testing.T) {
	ctx := context.Background()
	conn := &Conn{name: "s", acpSession: "ses-1", state: newACPSharedState()}
	turn := &acpTurn{workflows: newClaudeWorkflowWait()}
	conn.turn = turn
	client := &Client{children: map[string]bool{}, sessionConns: map[string]*Conn{"ses-1": conn}}

	params := func(sessionID string, message map[string]any) json.RawMessage {
		data, err := json.Marshal(map[string]any{"sessionId": sessionID, "message": message})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	started := map[string]any{
		"type": "system", "subtype": "task_started", "task_type": "local_workflow",
		"task_id": "t1", "run_id": "r1", "is_backgrounded": true,
	}
	tracked := func() int {
		w := turn.workflows
		w.mu.Lock()
		defer w.mu.Unlock()
		return len(w.tasks)
	}

	if _, err := client.HandleExtensionMethod(ctx, "_other/method", nil); err == nil {
		t.Fatal("未知扩展方法被接受")
	} else {
		var requestErr *acpsdk.RequestError
		if !errors.As(err, &requestErr) || requestErr.Code != -32601 {
			t.Fatalf("未知方法错误 = %v", err)
		}
	}
	if _, err := client.HandleExtensionMethod(ctx, claudeWorkflowMethod, json.RawMessage("{")); err == nil {
		t.Fatal("坏参数被接受")
	} else {
		var requestErr *acpsdk.RequestError
		if !errors.As(err, &requestErr) || requestErr.Code != -32602 {
			t.Fatalf("坏参数错误 = %v", err)
		}
	}
	// 陌生远端会话的 Workflow 消息被忽略，不触碰本会话跟踪器。
	if _, err := client.HandleExtensionMethod(ctx, claudeWorkflowMethod, params("ghost", started)); err != nil {
		t.Fatal(err)
	}
	if tracked() != 0 {
		t.Fatal("陌生会话的消息进入了跟踪器")
	}
	// 会话建立重放期间的消息不喂给正在建立的属主。
	client.replaying = true
	client.setupOwner = conn
	if _, err := client.HandleExtensionMethod(ctx, claudeWorkflowMethod, params("ses-1", started)); err != nil {
		t.Fatal(err)
	}
	if tracked() != 0 {
		t.Fatal("重放消息进入了跟踪器")
	}
	client.replaying = false
	client.setupOwner = nil
	if _, err := client.HandleExtensionMethod(ctx, claudeWorkflowMethod, params("ses-1", started)); err != nil {
		t.Fatal(err)
	}
	if tracked() != 1 {
		t.Fatal("正常投递没有进入跟踪器")
	}
	// 非 Claude 轮次没有跟踪器，消息被忽略且不能 panic。
	other := &Conn{name: "x", acpSession: "ses-x"}
	other.turn = &acpTurn{}
	client.sessionConns["ses-x"] = other
	if _, err := client.HandleExtensionMethod(ctx, claudeWorkflowMethod, params("ses-x", started)); err != nil {
		t.Fatal(err)
	}
}

// TestClaudeWorkflowMetaOnlyForClaude 非 Claude 客户端不订阅原始 SDK 消息，
// session/new 的 _meta 保持缺省。
func TestClaudeWorkflowMetaOnlyForClaude(t *testing.T) {
	if meta := (&Client{}).claudeWorkflowMeta(nil); meta != nil {
		t.Fatalf("非 Claude meta = %v", meta)
	}
	foreign := map[string]any{"claudeCode": map[string]any{"option": 1}, "other": "x"}
	if got := (&Client{}).claudeWorkflowMeta(foreign); !reflect.DeepEqual(got, foreign) {
		t.Fatalf("非 Claude meta 应保持不变: %v", got)
	}
	raw, err := json.Marshal((&Client{claudeWorkflows: true}).claudeWorkflowMeta(nil))
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	filters, ok := meta["claudeCode"].(map[string]any)["emitRawSDKMessages"].([]any)
	if !ok || len(filters) != 4 {
		t.Fatalf("meta = %s", raw)
	}
}

func TestClaudeWorkflowMetaMergesWithoutMutating(t *testing.T) {
	client := &Client{claudeWorkflows: true}
	inner := map[string]any{"nested": map[string]any{"depth": 1}}
	fork := map[string]any{"forkPoint": map[string]any{"kind": "latest"}}
	original := map[string]any{"claudeCode": inner, "jetbrains.air.fork": fork, "plain": "v"}
	merged := client.claudeWorkflowMeta(original)

	claude, ok := merged["claudeCode"].(map[string]any)
	if !ok {
		t.Fatalf("merged = %v", merged)
	}
	if !reflect.DeepEqual(claude["emitRawSDKMessages"], claudeWorkflowFilters) {
		t.Fatalf("filters = %v", claude["emitRawSDKMessages"])
	}
	if !reflect.DeepEqual(claude["nested"], inner["nested"]) {
		t.Fatalf("claudeCode 内嵌选项丢失: %v", claude)
	}
	if !reflect.DeepEqual(merged["jetbrains.air.fork"], fork) || merged["plain"] != "v" {
		t.Fatalf("同级 meta 丢失: %v", merged)
	}
	if len(inner) != 1 || len(original) != 3 {
		t.Fatalf("原始 meta 被修改: inner=%v original=%v", inner, original)
	}
	claude["__probe"] = true
	if _, shared := inner["__probe"]; shared {
		t.Fatal("claudeCode 子 map 应拷贝而不是共用")
	}
}

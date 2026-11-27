package acp

// 共享进程下，elicitation / permission 请求必须按请求自带的
// sessionId / toolCallId 找回属主会话，而不是最后 focus 的 owner。
// 回归：Devin 的 ask_user_question 曾串到兄弟会话，问题卡弹到
// 别人的流上，原会话干等或被立即取消。

import (
	"context"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/service/hitl"
)

func newRoutingFixture() (*Client, *probeHost, *Conn, *Conn, *probeSink, *probeSink) {
	host := &probeHost{elicit: hitl.NewElicitationRegistry(), perms: hitl.NewRegistry()}
	client := &Client{children: map[string]bool{}}
	sinkA := &probeSink{notify: make(chan string, 64)}
	sinkB := &probeSink{notify: make(chan string, 64)}
	ctx := context.Background()
	connA := &Conn{name: "a", client: client, acpSession: "ses-a", state: newACPSharedState()}
	connB := &Conn{name: "b", client: client, acpSession: "ses-b", state: newACPSharedState()}
	connA.turn = &acpTurn{host: host, sink: sinkA, session: "a", runCtx: ctx,
		tools: map[string]*acpTool{}, state: connA.state}
	connB.turn = &acpTurn{host: host, sink: sinkB, session: "b", runCtx: ctx,
		tools: map[string]*acpTool{}, state: connB.state}
	client.indexSession("ses-a", connA)
	// owner 停在最晚 Use 的会话 B 上，正是线上串台的场景。
	client.focus(connB, "ses-b")
	return client, host, connA, connB, sinkA, sinkB
}

func sinkEvents(s *probeSink) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.events...)
}

func TestElicitationRoutesByToolCallMeta(t *testing.T) {
	client, host, _, _, sinkA, sinkB := newRoutingFixture()
	ctx := context.Background()

	// 经真实通知路径登记：ses-a 名下发起过 tool call call-a。
	if err := client.SessionUpdate(ctx, acpsdk.SessionNotification{
		SessionId: "ses-a",
		Update:    acpsdk.StartToolCall("call-a", "ask_user_question"),
	}); err != nil {
		t.Fatal(err)
	}

	result := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		resp, err := client.UnstableCreateElicitation(ctx, acpsdk.UnstableCreateElicitationRequest{
			Form: &acpsdk.UnstableCreateElicitationForm{
				Mode:    "form",
				Message: "选哪个？",
				Meta:    map[string]any{"cognition.ai/toolCallId": "call-a"},
				RequestedSchema: acpsdk.UnstableElicitationSchema{
					Properties: map[string]any{"q0": map[string]any{"type": "string"}},
					Required:   []string{"q0"},
				},
			},
		})
		if err != nil {
			t.Errorf("UnstableCreateElicitation: %v", err)
		}
		result <- resp
	}()

	event := sinkA.waitFor("elicitation", 5*time.Second)
	if event == nil {
		t.Fatalf("elicitation 没有发到属主会话；seen=%v", sinkEvents(sinkA))
	}
	if got := sinkEvents(sinkB); len(got) != 0 {
		t.Fatalf("elicitation 串到了兄弟会话: %v", got)
	}
	id, _ := event["elicitationRequestId"].(string)
	if err := host.elicit.Resolve(id, "a", "accept", map[string]any{"q0": "答案"}); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	select {
	case resp := <-result:
		if resp.Accept == nil {
			t.Fatalf("expected accept response, got %+v", resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("elicitation 请求未返回")
	}
}

func TestPermissionRoutesBySessionID(t *testing.T) {
	client, host, _, _, sinkA, sinkB := newRoutingFixture()
	ctx := context.Background()

	result := make(chan acpsdk.RequestPermissionResponse, 1)
	go func() {
		resp, err := client.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
			SessionId: "ses-a",
			ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "call-a", Title: acpsdk.Ptr("读取文件")},
			Options: []acpsdk.PermissionOption{
				{OptionId: "allow", Name: "Allow", Kind: "allow_once"},
			},
		})
		if err != nil {
			t.Errorf("RequestPermission: %v", err)
		}
		result <- resp
	}()

	event := sinkA.waitFor("choice", 5*time.Second)
	if event == nil {
		t.Fatalf("choice 没有发到属主会话；seen=%v", sinkEvents(sinkA))
	}
	if got := sinkEvents(sinkB); len(got) != 0 {
		t.Fatalf("审批串到了兄弟会话: %v", got)
	}
	if pends := host.perms.Pending("a"); len(pends) != 1 {
		t.Fatalf("pending 审批应在 a 名下，got %d", len(pends))
	}
	if pends := host.perms.Pending("b"); len(pends) != 0 {
		t.Fatalf("b 不应有 pending 审批，got %d", len(pends))
	}
	id, _ := event["permissionRequestId"].(string)
	if err := host.perms.Resolve(id, "a", "allow"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	select {
	case resp := <-result:
		if resp.Outcome.Selected == nil || string(resp.Outcome.Selected.OptionId) != "allow" {
			t.Fatalf("expected selected allow, got %+v", resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("permission 请求未返回")
	}
}

// TestPermissionPrefersSessionIDOverToolCall toolCallId 会被不同会话复用，
// 显式 sessionId 才是路由依据：call-x 已索引到 B，A 名下的请求仍发给 A。
func TestPermissionPrefersSessionIDOverToolCall(t *testing.T) {
	client, host, _, _, sinkA, sinkB := newRoutingFixture()
	ctx := context.Background()
	client.indexToolSession("call-x", "ses-b")

	result := make(chan acpsdk.RequestPermissionResponse, 1)
	go func() {
		resp, err := client.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
			SessionId: "ses-a",
			ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "call-x", Title: acpsdk.Ptr("共享工具")},
			Options: []acpsdk.PermissionOption{
				{OptionId: "allow", Name: "Allow", Kind: "allow_once"},
			},
		})
		if err != nil {
			t.Errorf("RequestPermission: %v", err)
		}
		result <- resp
	}()

	event := sinkA.waitFor("choice", 5*time.Second)
	if event == nil {
		t.Fatalf("sessionId 显式指向 A 的审批串到了别处；seen=%v", sinkEvents(sinkA))
	}
	if got := sinkEvents(sinkB); len(got) != 0 {
		t.Fatalf("toolCallId 索引到 B 也不能把 A 的审批发给 B: %v", got)
	}
	id, _ := event["permissionRequestId"].(string)
	if err := host.perms.Resolve(id, "a", "allow"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	select {
	case resp := <-result:
		if resp.Outcome.Selected == nil || string(resp.Outcome.Selected.OptionId) != "allow" {
			t.Fatalf("expected selected allow, got %+v", resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("permission 请求未返回")
	}
}

// TestPermissionUnknownRemoteCancelled 陌生远端会话不发去当前 owner——
// 直接回 cancelled，不给兄弟会话弹别人的审批。
func TestPermissionUnknownRemoteCancelled(t *testing.T) {
	client, _, _, _, _, sinkB := newRoutingFixture()
	resp, err := client.RequestPermission(context.Background(), acpsdk.RequestPermissionRequest{
		SessionId: "ses-ghost",
		ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "call-x", Title: acpsdk.Ptr("陌生会话")},
		Options: []acpsdk.PermissionOption{
			{OptionId: "allow", Name: "Allow", Kind: "allow_once"},
		},
	})
	if err != nil {
		t.Fatalf("RequestPermission: %v", err)
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("未知会话的审批应回 cancelled: %+v", resp)
	}
	if got := sinkEvents(sinkB); len(got) != 0 {
		t.Fatalf("未知会话的审批不应落到 owner(B): %v", got)
	}
}

// TestPermissionChildFallsBackToOwner 原生子会话没有自己的 Conn，
// 它的审批退回父会话属主（这里是 focus 的 B）。
func TestPermissionChildFallsBackToOwner(t *testing.T) {
	client, host, _, _, sinkA, sinkB := newRoutingFixture()
	ctx := context.Background()
	client.mu.Lock()
	client.childSupported = true
	client.children["child-1"] = true
	client.mu.Unlock()

	result := make(chan acpsdk.RequestPermissionResponse, 1)
	go func() {
		resp, err := client.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
			SessionId: "child-1",
			ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "call-c", Title: acpsdk.Ptr("子会话工具")},
			Options: []acpsdk.PermissionOption{
				{OptionId: "allow", Name: "Allow", Kind: "allow_once"},
			},
		})
		if err != nil {
			t.Errorf("RequestPermission: %v", err)
		}
		result <- resp
	}()

	event := sinkB.waitFor("choice", 5*time.Second)
	if event == nil {
		t.Fatalf("子会话审批应退回父会话属主 B；seen=%v", sinkEvents(sinkB))
	}
	if got := sinkEvents(sinkA); len(got) != 0 {
		t.Fatalf("子会话审批不应发给 A: %v", got)
	}
	id, _ := event["permissionRequestId"].(string)
	if err := host.perms.Resolve(id, "b", "allow"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	select {
	case resp := <-result:
		if resp.Outcome.Selected == nil || string(resp.Outcome.Selected.OptionId) != "allow" {
			t.Fatalf("expected selected allow, got %+v", resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("permission 请求未返回")
	}
}

// TestPermissionInvalidOptionCancelled handler 返回的选项必须来自请求广播的
// option id；PermissionFunc 直接返回非法值时按取消处理，不能把非法选项回执给 Agent。
// （经 turn.permission 的路径已由 hitl registry 校验过，这条防线守的是裸回调。）
func TestPermissionInvalidOptionCancelled(t *testing.T) {
	client := &Client{
		children:     map[string]bool{},
		sessionConns: map[string]*Conn{},
		toolSessions: map[string]string{},
		sessionID:    "ses-1",
		perm: func(context.Context, PermissionRequest) (string, bool) {
			return "bogus-option", true
		},
	}
	resp, err := client.RequestPermission(context.Background(), acpsdk.RequestPermissionRequest{
		SessionId: "ses-1",
		ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "call-1", Title: acpsdk.Ptr("执行")},
		Options: []acpsdk.PermissionOption{
			{OptionId: "allow", Name: "Allow", Kind: "allow_once"},
		},
	})
	if err != nil {
		t.Fatalf("RequestPermission: %v", err)
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("非法选项应回 cancelled: %+v", resp)
	}
}

func TestElicitationUnknownRouteFallsBackToOwner(t *testing.T) {
	client, host, _, _, sinkA, sinkB := newRoutingFixture()
	ctx := context.Background()

	// meta 里没有可解析的 toolCallId（非 Devin agent），退回 owner(B)，
	// 与单会话进程下的旧行为一致。
	result := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		resp, err := client.UnstableCreateElicitation(ctx, acpsdk.UnstableCreateElicitationRequest{
			Form: &acpsdk.UnstableCreateElicitationForm{
				Mode:    "form",
				Message: "选哪个？",
				RequestedSchema: acpsdk.UnstableElicitationSchema{
					Properties: map[string]any{"q0": map[string]any{"type": "string"}},
				},
			},
		})
		if err != nil {
			t.Errorf("UnstableCreateElicitation: %v", err)
		}
		result <- resp
	}()

	event := sinkB.waitFor("elicitation", 5*time.Second)
	if event == nil {
		t.Fatalf("未知路由应退回 owner；seen=%v", sinkEvents(sinkB))
	}
	if got := sinkEvents(sinkA); len(got) != 0 {
		t.Fatalf("事件不应发到非属主会话: %v", got)
	}
	id, _ := event["elicitationRequestId"].(string)
	if err := host.elicit.Resolve(id, "b", "accept", map[string]any{"q0": "答案"}); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	select {
	case resp := <-result:
		if resp.Accept == nil {
			t.Fatalf("expected accept response, got %+v", resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("elicitation 请求未返回")
	}
}

func TestClearOwnerPurgesRoutingIndex(t *testing.T) {
	client, _, connA, connB, _, _ := newRoutingFixture()
	client.indexToolSession("call-a", "ses-a")
	client.clearOwner(connB)
	if got := client.requestOwner("ses-b", ""); got != nil {
		t.Fatalf("ses-b 的索引应随 conn 清掉，got %v", got.name)
	}
	if got := client.requestOwner("ses-a", "call-a"); got != connA {
		t.Fatalf("ses-a 的索引应保留并解析到属主")
	}
}

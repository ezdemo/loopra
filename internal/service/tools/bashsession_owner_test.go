package tools

import (
	"context"
	"testing"

	agentpkg "google.golang.org/adk/v2/agent"
)

// fakeToolCtx 只实现 sessionOwner 需要的两个方法。
type fakeToolCtx struct {
	agentpkg.Context
	values map[any]any
	sid    string
}

func (f *fakeToolCtx) Value(key any) any { return f.values[key] }
func (f *fakeToolCtx) SessionID() string { return f.sid }

// 子代理运行在独立的 sub-* 会话里，显式标注的父会话必须优先于 ADK 会话 ID，
// 否则 sub_agent 启动的后台进程会挂在用户看不到的会话下。
func TestSessionOwnerPrefersExplicitParent(t *testing.T) {
	if got := sessionOwner(&fakeToolCtx{values: map[any]any{}, sid: "sub-abc"}); got != "sub-abc" {
		t.Fatalf("owner without annotation = %q", got)
	}
	ctx := WithSessionOwner(context.Background(), "loopra-parent")
	if ctx.Value(sessionOwnerKey{}) != "loopra-parent" {
		t.Fatal("annotation missing from context")
	}
	annotated := &fakeToolCtx{values: map[any]any{sessionOwnerKey{}: ctx.Value(sessionOwnerKey{})}, sid: "sub-abc"}
	if got := sessionOwner(annotated); got != "loopra-parent" {
		t.Fatalf("annotated owner = %q", got)
	}
	// 空归属不应写进上下文，否则会把进程标成一个找不到的会话。
	if WithSessionOwner(context.Background(), "") != context.Background() {
		t.Fatal("empty owner must be a no-op")
	}
	if got := sessionOwner(nil); got != "" {
		t.Fatalf("nil context owner = %q", got)
	}
}

// 启动时打标的归属必须真的落到注册表里，并通过面板的读接口生效。
func TestStartedSessionCarriesOwnerIntoRegistry(t *testing.T) {
	root := t.TempDir()
	s, err := startBashSession(root, "echo owner-probe", "loopra-parent")
	if err != nil {
		t.Skipf("interactive shell unavailable: %v", err)
	}
	defer BashSessionTerminate(s.id, "loopra-parent")
	s.wait(0, 1500, 10000)

	if got := s.owner; got != "loopra-parent" {
		t.Fatalf("owner = %q", got)
	}
	list := BashSessionsSnapshot("loopra-parent")
	if len(list) != 1 || list[0]["owner"] != "loopra-parent" {
		t.Fatalf("snapshot = %v", list)
	}
	if _, ok := BashSessionEntry(s.id, "other-session"); ok {
		t.Fatal("another session resolved this entry")
	}
}

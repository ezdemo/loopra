package tools

import (
	"context"
	"testing"

	agentpkg "google.golang.org/adk/v2/agent"
)

func testSessionOwner(name string) SessionOwner {
	return SessionOwner{Workspace: "test", Session: name}
}

// fakeToolCtx 只实现 sessionOwner 需要的方法。
type fakeToolCtx struct {
	agentpkg.Context
	values map[any]any
	sid    string
	app    string
}

func (f *fakeToolCtx) Value(key any) any { return f.values[key] }
func (f *fakeToolCtx) SessionID() string { return f.sid }
func (f *fakeToolCtx) AppName() string   { return f.app }

// 子代理运行在独立的 sub-* 会话里，显式标注的父会话必须优先于 ADK 会话 ID，
// 否则 sub_agent 启动的后台进程会挂在用户看不到的会话下。
func TestSessionOwnerPrefersExplicitParent(t *testing.T) {
	child := &fakeToolCtx{values: map[any]any{}, sid: "sub-abc", app: "child-app"}
	if got := sessionOwner(child); got != (SessionOwner{Workspace: child.app, Session: child.sid}) {
		t.Fatalf("owner without annotation = %+v", got)
	}
	parent := testSessionOwner("loopra-parent")
	ctx := WithSessionOwner(context.Background(), parent)
	if ctx.Value(sessionOwnerKey{}) != parent {
		t.Fatal("annotation missing from context")
	}
	annotated := &fakeToolCtx{values: map[any]any{sessionOwnerKey{}: ctx.Value(sessionOwnerKey{})}, sid: "sub-abc"}
	if got := sessionOwner(annotated); got != parent {
		t.Fatalf("annotated owner = %+v", got)
	}
	// 空归属不应写进上下文，否则会把进程标成一个找不到的会话。
	if WithSessionOwner(context.Background(), SessionOwner{}) != context.Background() {
		t.Fatal("empty owner must be a no-op")
	}
	if got := sessionOwner(nil); got != (SessionOwner{}) {
		t.Fatalf("nil context owner = %+v", got)
	}
}

// 启动时打标的归属必须真的落到注册表里，并通过面板的读接口生效。
func TestStartedSessionCarriesOwnerIntoRegistry(t *testing.T) {
	root := t.TempDir()
	owner := testSessionOwner("loopra-parent")
	s, err := startBashSession(root, "echo owner-probe", owner)
	if err != nil {
		t.Skipf("interactive shell unavailable: %v", err)
	}
	defer BashSessionTerminate(s.id, owner)
	s.wait(0, 1500, 10000)

	if got := s.owner; got != owner {
		t.Fatalf("owner = %+v", got)
	}
	list := BashSessionsSnapshot(owner)
	if len(list) != 1 || list[0]["owner"] != owner.Session || list[0]["workspaceHash"] != owner.Workspace {
		t.Fatalf("snapshot = %v", list)
	}
	if _, ok := BashSessionEntry(s.id, testSessionOwner("other-session")); ok {
		t.Fatal("another session resolved this entry")
	}
}

func TestSameSessionNameInDifferentWorkspacesIsIsolated(t *testing.T) {
	a := SessionOwner{Workspace: "project-a", Session: "default"}
	b := SessionOwner{Workspace: "project-b", Session: "default"}
	mine, theirs := newBashID(), newBashID()
	bashMu.Lock()
	bashSessions[mine] = &bashSession{id: mine, owner: a, status: "running"}
	bashSessions[theirs] = &bashSession{id: theirs, owner: b, status: "running"}
	bashMu.Unlock()
	t.Cleanup(func() {
		BashSessionTerminate(mine, a)
		BashSessionTerminate(theirs, b)
	})

	if got := BashSessionsSnapshot(a); len(got) != 1 || got[0]["sessionId"] != mine {
		t.Fatalf("project-a snapshot = %v", got)
	}
	if _, ok := BashSessionLog(theirs, a); ok {
		t.Fatal("project-a read project-b's log")
	}
	if n := BashSessionTerminate(theirs, a); n != 0 {
		t.Fatalf("project-a terminated project-b's shell: %d", n)
	}
	if n := BashSessionTerminate("", a); n != 1 {
		t.Fatalf("project-a terminate-all = %d", n)
	}
	if _, ok := BashSessionEntry(theirs, b); !ok {
		t.Fatal("project-b's shell was removed")
	}
}

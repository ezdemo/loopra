package acp

import (
	"context"
	"errors"
	"testing"

	"github.com/ezdemo/looprax/internal/service/hitl"
)

type reuseHost struct {
	app       string
	workspace string
	meta      map[string]map[string]any
}

func (h *reuseHost) App() string          { return h.app }
func (h *reuseHost) Workspace() string    { return h.workspace }
func (h *reuseHost) LinkedDirs() []string { return nil }
func (h *reuseHost) Meta(name string) map[string]any {
	if h.meta == nil {
		return nil
	}
	return h.meta[name]
}
func (h *reuseHost) SetMeta(name string, kv map[string]any) {
	if h.meta == nil {
		h.meta = map[string]map[string]any{}
	}
	current := h.meta[name]
	if current == nil {
		current = map[string]any{}
	}
	for key, value := range kv {
		current[key] = value
	}
	h.meta[name] = current
}
func (h *reuseHost) AppendTranscript(string, []map[string]any) error { return nil }
func (h *reuseHost) SubSessionsDir(string) string                    { return "" }
func (h *reuseHost) MCPServers(string) []any                         { return nil }
func (h *reuseHost) Permissions() *hitl.Registry                     { return nil }
func (h *reuseHost) Elicitations() *hitl.ElicitationRegistry         { return nil }
func (h *reuseHost) EnsureTitle(context.Context, string, string)     {}

func stubCodex(t *testing.T) {
	t.Helper()
	previous := Providers
	t.Cleanup(func() { Providers = previous })
	Providers = []Provider{{
		ID:   "codex",
		Name: "Codex",
		Prepare: func(string) (Launch, error) {
			return Launch{}, errors.New("unexpected process start")
		},
	}}
}

func TestOpenSessionUsesConnLocalOptions(t *testing.T) {
	host := &reuseHost{app: "app", workspace: `C:\work`}
	client := &Client{
		sessionID:     "other",
		configOptions: []ConfigOption{{ID: "mode", CurrentValue: "other"}},
	}
	conn := &Conn{
		client:     client,
		live:       true,
		acpSession: "mine",
		options:    []ConfigOption{{ID: "mode", CurrentValue: "ask"}},
	}
	got, err := NewManager().OpenSession(context.Background(), host, "s", conn, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].CurrentValue != "ask" {
		t.Fatalf("options = %#v", got)
	}
	if client.SessionID() != "mine" {
		t.Fatalf("focused session = %q", client.SessionID())
	}
}

func TestAcquireReusesIdleProcessUntilLastSessionDrops(t *testing.T) {
	stubCodex(t)
	host := &reuseHost{app: "app", workspace: `C:\work`}
	manager := NewManager()
	proc := &agentProcess{}
	client := &Client{proc: proc, children: map[string]bool{}}
	rtKey := runtimeKey(host, "codex")
	manager.runtimes[rtKey] = &acpRuntime{client: client, refs: 1}
	manager.conns[manager.key(host, "one")] = &Conn{
		name: "one", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey, acpSession: "ses-1", live: true,
	}

	conn, err := manager.Acquire(context.Background(), host, "two", "codex", "test")
	if err != nil {
		t.Fatal(err)
	}
	if conn.client != client {
		t.Fatal("new session did not reuse the idle process")
	}
	if manager.runtimes[rtKey].refs != 2 {
		t.Fatalf("refs = %d", manager.runtimes[rtKey].refs)
	}
	manager.Drop(manager.key(host, "two"))
	if manager.runtimes[rtKey] == nil || manager.runtimes[rtKey].refs != 1 {
		t.Fatalf("runtime after first drop = %#v", manager.runtimes[rtKey])
	}
	if !client.Alive() {
		t.Fatal("process closed while another session still uses it")
	}
	manager.Drop(manager.key(host, "one"))
	if client.Alive() {
		t.Fatal("process still alive after the last session dropped")
	}
	if _, ok := manager.runtimes[rtKey]; ok {
		t.Fatal("runtime entry leaked")
	}
}

func TestAcquireDoesNotShareABusyProcess(t *testing.T) {
	stubCodex(t)
	host := &reuseHost{app: "app", workspace: `C:\work`}
	manager := NewManager()
	proc := &agentProcess{}
	client := &Client{proc: proc, children: map[string]bool{}}
	rtKey := runtimeKey(host, "codex")
	manager.runtimes[rtKey] = &acpRuntime{client: client, refs: 1}
	manager.conns[manager.key(host, "one")] = &Conn{
		name: "one", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey, acpSession: "ses-1", live: true, running: true,
	}

	_, err := manager.Acquire(context.Background(), host, "two", "codex", "test")
	if err == nil || err.Error() != "unexpected process start" {
		t.Fatalf("err = %v", err)
	}
	if !client.Alive() {
		t.Fatal("busy process was closed")
	}
	if manager.runtimes[rtKey] == nil || manager.runtimes[rtKey].refs != 1 {
		t.Fatalf("runtime = %#v", manager.runtimes[rtKey])
	}
}

func TestAcquireDetachesSessionBlockedByAnotherTurn(t *testing.T) {
	stubCodex(t)
	host := &reuseHost{app: "app", workspace: `C:\work`}
	manager := NewManager()
	proc := &agentProcess{}
	client := &Client{proc: proc, children: map[string]bool{}}
	rtKey := runtimeKey(host, "codex")
	manager.runtimes[rtKey] = &acpRuntime{client: client, refs: 2}
	manager.conns[manager.key(host, "one")] = &Conn{
		name: "one", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey, acpSession: "ses-1", live: true, running: true,
	}
	manager.conns[manager.key(host, "two")] = &Conn{
		name: "two", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey, acpSession: "ses-2", live: true,
	}

	_, err := manager.Acquire(context.Background(), host, "two", "codex", "test")
	if err == nil || err.Error() != "unexpected process start" {
		t.Fatalf("err = %v", err)
	}
	if !client.Alive() {
		t.Fatal("shared process closed while a turn is still running")
	}
	if manager.runtimes[rtKey] == nil || manager.runtimes[rtKey].refs != 1 {
		t.Fatalf("refs = %d", manager.runtimes[rtKey].refs)
	}
	detached := manager.get(manager.key(host, "two"))
	if detached == nil || detached.client != nil || detached.live {
		t.Fatal("blocked session was not detached from the busy process")
	}
}

func TestIdleSessionsSkipsBusyAndUnopened(t *testing.T) {
	host := &reuseHost{app: "app", workspace: `C:\work`}
	manager := NewManager()
	client := &Client{proc: &agentProcess{}, children: map[string]bool{}}
	rtKey := runtimeKey(host, "codex")
	manager.conns[manager.key(host, "draft")] = &Conn{
		name: "draft", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey, acpSession: "ses-draft", live: true,
	}
	manager.conns[manager.key(host, "busy")] = &Conn{
		name: "busy", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey, acpSession: "ses-busy", live: true, busy: true,
	}
	manager.conns[manager.key(host, "pending")] = &Conn{
		name: "pending", agentID: "codex", cwd: host.Workspace(),
		client: client, runtimeKey: rtKey,
	}
	names := manager.IdleSessions(host, "codex", host.Workspace())
	if len(names) != 1 || names[0] != "draft" {
		t.Fatalf("idle = %#v", names)
	}
}

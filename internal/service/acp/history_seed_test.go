package acp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type seedHost struct {
	reuseHost
	history    []map[string]any
	historyErr error
	// seedErr 只拦 acpHistorySeededSessionId 的写入；metaErr 拦所有写入。
	seedErr error
	metaErr error
}

func (h *seedHost) History(string) ([]map[string]any, error) { return h.history, h.historyErr }

func (h *seedHost) SetMeta(name string, kv map[string]any) error {
	if h.metaErr != nil {
		return h.metaErr
	}
	if _, seeded := kv["acpHistorySeededSessionId"]; seeded && h.seedErr != nil {
		return h.seedErr
	}
	return h.reuseHost.SetMeta(name, kv)
}

type recordSink struct {
	discardSink
	failures []string
}

func (s *recordSink) SendError(message string) { s.failures = append(s.failures, message) }

// seedManager 把一条已绑定远端的 live 连接注册进管理器，让 RunTurn
// 直接复用它；同时把 provider 换成必然失败的桩，任何额外的进程拉起
// 都会暴露为错误而不是真的启动外部 Agent。
func seedManager(t *testing.T, host *seedHost, conn *Conn) *Manager {
	t.Helper()
	stubReuseProvider(t, "codex")
	manager := NewManager()
	manager.put(manager.key(host, "s"), conn)
	return manager
}

// seedTurn 在一条已绑定远端的 live 连接上跑一轮，模拟发送入口的真实路径。
func seedTurn(t *testing.T, manager *Manager, host *seedHost, conn *Conn, sink EventSink, message string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	manager.RunTurn(ctx, host, sink, TurnInput{Session: "s", AgentID: "codex", Message: message}, "msg", false, "test")
}

func seedConn(t *testing.T, workspace string, env map[string]string) *Conn {
	t.Helper()
	client := fakeClientEnv(t, nil, env)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	setup, err := client.NewSession(ctx, workspace, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &Conn{
		name: "s", agentID: "codex", cwd: workspace, client: client,
		acpSession: setup.SessionID, live: true, state: newACPSharedState(),
	}
}

func promptLog(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		t.Fatal(err)
	}
	parts := strings.Split(string(raw), "\n---\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func TestRunTurnSeedsHistoryIntoFreshRemoteOnlyOnce(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()},
		history: []map[string]any{
			{"role": "user", "content": "旧问题"},
			{"role": "assistant", "content": "旧答复"},
		}}
	conn := seedConn(t, host.workspace, map[string]string{"LOOPRA_ACP_FAKE_PROMPT_LOG": log})
	host.SetMeta("s", map[string]any{"agentId": "codex", "acpHistorySeed": true})
	manager := seedManager(t, host, conn)
	sink := &recordSink{}
	seedTurn(t, manager, host, conn, sink, "继续")
	if len(sink.failures) != 0 {
		t.Fatalf("failures = %v", sink.failures)
	}
	prompts := promptLog(t, log)
	if len(prompts) != 1 || !strings.HasPrefix(prompts[0], historyPromptPrefix) || !strings.HasSuffix(prompts[0], "\n</conversation_history>\n\nCurrent user request:\n继续") {
		t.Fatalf("first prompt = %#v", prompts)
	}
	if !strings.Contains(prompts[0], "旧问题") || !strings.Contains(prompts[0], "旧答复") {
		t.Fatalf("history missing from first prompt: %q", prompts[0])
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != "fake-session" {
		t.Fatalf("seeded marker = %#v", got)
	}
	// 同一远端的后续提示词不再携带历史。
	seedTurn(t, manager, host, conn, sink, "再问")
	prompts = promptLog(t, log)
	if len(prompts) != 2 || prompts[1] != "再问" {
		t.Fatalf("second prompt = %#v", prompts)
	}
	// 换到新远端后按当前可见历史重新注入。
	conn.acpSession = "session-new"
	seedTurn(t, manager, host, conn, sink, "换远端")
	prompts = promptLog(t, log)
	if len(prompts) != 3 || !strings.Contains(prompts[2], "旧问题") || !strings.HasSuffix(prompts[2], "Current user request:\n换远端") {
		t.Fatalf("third prompt = %#v", prompts)
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != "session-new" {
		t.Fatalf("seeded marker after new remote = %#v", got)
	}
}

func TestRunTurnFailedSeedPromptStaysPendingUntilRetry(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "prompts.log")
	fail := filepath.Join(dir, "fail")
	if err := os.WriteFile(fail, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()},
		history: []map[string]any{{"role": "user", "content": "旧问题"}}}
	conn := seedConn(t, host.workspace, map[string]string{
		"LOOPRA_ACP_FAKE_PROMPT_LOG": log,
		"LOOPRA_ACP_FAKE_FAIL":       fail,
	})
	host.SetMeta("s", map[string]any{"agentId": "codex", "acpHistorySeed": true})
	manager := seedManager(t, host, conn)
	sink := &recordSink{}
	seedTurn(t, manager, host, conn, sink, "继续")
	if len(sink.failures) == 0 {
		t.Fatal("injected prompt failure did not surface")
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != nil {
		t.Fatalf("failed prompt marked seeded: %#v", got)
	}
	if got := host.Meta("s")["acpHistorySeed"]; got != true {
		t.Fatalf("failed prompt consumed seed marker: %#v", got)
	}
	if err := os.Remove(fail); err != nil {
		t.Fatal(err)
	}
	sink.failures = nil
	seedTurn(t, manager, host, conn, sink, "继续")
	if len(sink.failures) != 0 {
		t.Fatalf("retry failures = %v", sink.failures)
	}
	prompts := promptLog(t, log)
	if len(prompts) != 2 || !strings.Contains(prompts[1], "旧问题") {
		t.Fatalf("retried prompt lost history: %#v", prompts)
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != "fake-session" {
		t.Fatalf("seeded marker after retry = %#v", got)
	}
}

func TestRunTurnHistoryReadFailureAbortsPrompt(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()}, historyErr: errors.New("disk gone")}
	conn := seedConn(t, host.workspace, map[string]string{"LOOPRA_ACP_FAKE_PROMPT_LOG": log})
	host.SetMeta("s", map[string]any{"agentId": "codex", "acpHistorySeed": true})
	sink := &recordSink{}
	seedTurn(t, seedManager(t, host, conn), host, conn, sink, "继续")
	if len(sink.failures) == 0 {
		t.Fatal("history read failure did not surface")
	}
	if prompts := promptLog(t, log); len(prompts) != 0 {
		t.Fatalf("prompt sent without history: %#v", prompts)
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != nil {
		t.Fatalf("failed read marked seeded: %#v", got)
	}
}

// 种子标记落盘失败要作为轮次失败暴露：标记缺失时下一次发送仍带着历史，
// 不会把没收到历史的远端当成已注入。
func TestRunTurnSeedMarkerWriteFailureStaysPending(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()},
		history: []map[string]any{{"role": "user", "content": "旧问题"}},
		seedErr: errors.New("meta store down")}
	conn := seedConn(t, host.workspace, map[string]string{"LOOPRA_ACP_FAKE_PROMPT_LOG": log})
	host.SetMeta("s", map[string]any{"agentId": "codex", "acpHistorySeed": true})
	manager := seedManager(t, host, conn)
	sink := &recordSink{}
	seedTurn(t, manager, host, conn, sink, "继续")
	if len(sink.failures) == 0 {
		t.Fatal("marker write failure did not surface")
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != nil {
		t.Fatalf("failed marker write recorded seeded id: %#v", got)
	}
	if got := host.Meta("s")["acpHistorySeed"]; got != true {
		t.Fatalf("failed marker write consumed seed flag: %#v", got)
	}
	// 已发送的提示词带历史；写盘恢复后同一条远端补种成功，不重建远端。
	prompts := promptLog(t, log)
	if len(prompts) != 1 || !strings.Contains(prompts[0], "旧问题") {
		t.Fatalf("first prompt = %#v", prompts)
	}
	host.seedErr = nil
	sink.failures = nil
	seedTurn(t, manager, host, conn, sink, "继续")
	if len(sink.failures) != 0 {
		t.Fatalf("retry failures = %v", sink.failures)
	}
	prompts = promptLog(t, log)
	if len(prompts) != 2 || !strings.Contains(prompts[1], "旧问题") {
		t.Fatalf("retry prompt lost history: %#v", prompts)
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != "fake-session" {
		t.Fatalf("seeded marker after retry = %#v", got)
	}
}

// 取消发生在提示词已发出、标记未落盘之间时，种子保持待注入，
// 重新发送仍携带历史。
func TestRunTurnCancelledSeedKeepsPendingMarker(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()},
		history: []map[string]any{{"role": "user", "content": "旧问题"}}}
	conn := seedConn(t, host.workspace, map[string]string{
		"LOOPRA_ACP_FAKE_PROMPT_LOG":  log,
		"LOOPRA_ACP_FAKE_WAIT_CANCEL": "1",
	})
	host.SetMeta("s", map[string]any{"agentId": "codex", "acpHistorySeed": true})
	manager := seedManager(t, host, conn)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		manager.RunTurn(ctx, host, &recordSink{}, TurnInput{Session: "s", AgentID: "codex", Message: "继续"}, "msg", false, "test")
		close(done)
	}()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && len(promptLog(t, log)) == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if len(promptLog(t, log)) == 0 {
		cancel()
		t.Fatal("prompt never reached the fake agent")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("cancelled turn did not finish")
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != nil {
		t.Fatalf("cancelled turn marked seeded: %#v", got)
	}
	if got := host.Meta("s")["acpHistorySeed"]; got != true {
		t.Fatalf("cancelled turn consumed seed flag: %#v", got)
	}
}

// 远端已建立但绑定信息写盘失败时，连接不能带着未持久化的绑定继续用。
func TestOpenSessionMetaWriteFailureLeavesUnbound(t *testing.T) {
	client := fakeClientEnv(t, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()},
		metaErr: errors.New("meta store down")}
	conn := &Conn{name: "s", agentID: "codex", cwd: host.workspace, client: client, state: newACPSharedState()}
	if _, err := NewManager().OpenSession(ctx, host, "s", conn, true); err == nil {
		t.Fatal("metadata write failure did not surface")
	}
	if conn.live || conn.SessionID() != "" {
		t.Fatalf("connection bound without persisted meta: live=%v remote=%q", conn.live, conn.SessionID())
	}
}

// 建立远端绑定（prepare/config 路径）不消耗种子：种子只在发送时注入。
func TestOpenSessionDoesNotConsumeHistorySeed(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	client := fakeClientEnv(t, nil, map[string]string{"LOOPRA_ACP_FAKE_PROMPT_LOG": log})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()},
		history: []map[string]any{{"role": "user", "content": "旧问题"}}}
	host.SetMeta("s", map[string]any{"agentId": "codex", "acpHistorySeed": true})
	conn := &Conn{name: "s", agentID: "codex", cwd: host.workspace, client: client, state: newACPSharedState()}
	if _, err := NewManager().OpenSession(ctx, host, "s", conn, true); err != nil {
		t.Fatal(err)
	}
	if conn.SessionID() != "fake-session" {
		t.Fatalf("remote = %q", conn.SessionID())
	}
	if prompts := promptLog(t, log); len(prompts) != 0 {
		t.Fatalf("session setup sent a prompt: %#v", prompts)
	}
	if got := host.Meta("s")["acpHistorySeededSessionId"]; got != nil {
		t.Fatalf("setup marked seeded: %#v", got)
	}
}

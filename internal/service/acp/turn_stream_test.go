package acp

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type streamHost struct {
	reuseHost
	dir   string
	mu    sync.Mutex
	lines []map[string]any
}

func (h *streamHost) SubSessionsDir(string) string { return h.dir }
func (h *streamHost) AppendTranscript(_ string, lines []map[string]any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lines = append(h.lines, lines...)
	return nil
}

type streamSink struct {
	discardSink
	entered    chan struct{}
	release    chan struct{}
	once       sync.Once
	types      []string
	payloads   []map[string]any
	wireBytes  int
	deltaBytes int
	failure    string
}

func (s *streamSink) Send(typ string, value any) {
	s.once.Do(func() {
		close(s.entered)
		<-s.release
	})
	payload, _ := value.(map[string]any)
	data, _ := json.Marshal(value)
	s.wireBytes += len(data)
	if delta, ok := payload["resultDelta"].(string); ok {
		s.deltaBytes += len(delta)
	}
	s.types = append(s.types, typ)
	s.payloads = append(s.payloads, payload)
}
func (s *streamSink) SendText(typ, value string) {
	s.Send(typ, map[string]any{"text": value})
}
func (s *streamSink) SendError(message string) {
	s.failure = message
	s.Send("error", map[string]any{"error": message})
}
func (s *streamSink) Done() { s.Send("done", nil) }

func TestRunTurnBurstWithBlockedSSEDrainsBeforeDone(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	host := &streamHost{reuseHost: reuseHost{app: "test", workspace: t.TempDir()}, dir: t.TempDir()}
	client := fakeClient(t, nil)
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	setup, err := client.NewSession(ctx, host.workspace, nil)
	if err != nil {
		t.Fatal(err)
	}
	conn := &Conn{
		name: "s", agentID: "codex", cwd: host.workspace, client: client,
		acpSession: setup.SessionID, live: true, state: newACPSharedState(),
	}
	manager := NewManager()
	manager.put(manager.key(host, "s"), conn)
	sink := &streamSink{entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(sink.release) })
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		manager.RunTurn(ctx, host, sink, TurnInput{Session: "s", AgentID: "codex", Message: "burst"}, "msg", false, "test")
	}()
	select {
	case <-sink.entered:
	case <-ctx.Done():
		t.Fatal("turn did not reach SSE")
	}
	// Let the actual SDK receive a >1024 notification burst while the first
	// SSE write is blocked. RunTurn must reach its own drain barrier.
	for {
		turn := conn.currentTurn()
		if turn != nil {
			turn.events.mu.Lock()
			closed := turn.events.closed
			turn.events.mu.Unlock()
			if closed {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("SDK could not finish receiving the burst with SSE blocked")
		case <-time.After(5 * time.Millisecond):
		}
	}
	select {
	case <-finished:
		t.Fatal("RunTurn finished before its accepted events were processed")
	default:
	}
	release.Do(func() { close(sink.release) })
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("turn did not finish draining")
	}
	if sink.failure != "" {
		t.Fatal(sink.failure)
	}
	if !client.Alive() {
		t.Fatal("SDK connection closed during burst")
	}
	if sink.deltaBytes != 4096*128 {
		t.Fatalf("delta bytes = %d", sink.deltaBytes)
	}
	// Includes one final full snapshot. Repeated cumulative snapshots would
	// transfer roughly a gigabyte for this half-megabyte tool result.
	if sink.wireBytes > 2<<20 {
		t.Fatalf("wire output amplified to %d bytes", sink.wireBytes)
	}
	n := len(sink.types)
	if n < 2 || sink.types[n-2] != "complete" || sink.types[n-1] != "done" {
		t.Fatalf("last events = %v", sink.types[max(0, n-3):])
	}
	host.mu.Lock()
	defer host.mu.Unlock()
	var tool, assistant string
	for _, line := range host.lines {
		switch line["role"] {
		case "tool":
			tool, _ = line["content"].(string)
		case "assistant":
			if text, ok := line["content"].(string); ok {
				assistant += text
			}
		}
	}
	if tool != strings.Repeat("x", 4096*128)+"\n\nExit code: 0" || assistant != "done" {
		t.Fatalf("incomplete transcript: tool=%d bytes, assistant=%q", len(tool), assistant)
	}
}

func TestSDKOverflowDiagnosticSurvivesQuietLogging(t *testing.T) {
	client := &Client{}
	logger := slog.New(connectionLog{Handler: slog.DiscardHandler, client: client}).WithGroup("sdk")
	logger.Error("failed to queue notification; closing connection", "err", errors.New("notification queue overflow"))
	if !errors.Is(client.disconnectErr, ErrNotificationOverflow) {
		t.Fatalf("disconnect cause = %v", client.disconnectErr)
	}
	if strings.Contains(TranslateFailure(client.disconnectErr).Error(), "登录") {
		t.Fatal("queue overflow still suggests a login problem")
	}
}

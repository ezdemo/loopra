package acp

// Manual probe against the real `devin acp` binary. Run with:
//   go test ./internal/service/acp -run TestDevinElicitationProbe -v
// Skips when devin is not installed or not logged in.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/service/hitl"
)

type probeHost struct {
	reuseHost
	elicit *hitl.ElicitationRegistry
	perms  *hitl.Registry
}

func (h *probeHost) Elicitations() *hitl.ElicitationRegistry { return h.elicit }
func (h *probeHost) Permissions() *hitl.Registry             { return h.perms }

type probeSink struct {
	mu     sync.Mutex
	events []string
	raw    []map[string]any
	notify chan string
}

func (s *probeSink) Send(typ string, value any) {
	s.mu.Lock()
	s.events = append(s.events, typ)
	payload, _ := value.(map[string]any)
	s.raw = append(s.raw, payload)
	s.mu.Unlock()
	select {
	case s.notify <- typ:
	default:
	}
}
func (s *probeSink) SendText(typ, text string) {
	s.Send(typ, map[string]any{"text": text})
}
func (s *probeSink) SendRaw(typ string, data []byte) {
	s.Send(typ, map[string]any{"raw": string(data)})
}
func (s *probeSink) SendError(message string) { s.Send("error", map[string]any{"error": message}) }
func (s *probeSink) Done()                    { s.Send("done", nil) }

func (s *probeSink) waitFor(want string, timeout time.Duration) map[string]any {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		for i, typ := range s.events {
			if typ == want {
				var payload map[string]any
				if i < len(s.raw) {
					payload = s.raw[i]
				}
				s.mu.Unlock()
				return payload
			}
		}
		s.mu.Unlock()
		select {
		case <-s.notify:
		case <-time.After(50 * time.Millisecond):
		}
	}
	return nil
}

func TestDevinElicitationProbe(t *testing.T) {
	if devinCredential() == nil {
		t.Skip("devin credentials unavailable")
	}
	if findDevin(searchRoots()) == "" {
		t.Skip("devin binary unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()
	host := &probeHost{
		reuseHost: reuseHost{app: "probe", workspace: t.TempDir()},
		elicit:    hitl.NewElicitationRegistry(),
		perms:     hitl.NewRegistry(),
	}
	manager := NewManager()
	defer manager.CloseAll()
	sink := &probeSink{notify: make(chan string, 256)}

	// 复刻真实工作台：同一 session 先跑一轮普通回复，复用进程再触发提问。
	first := make(chan struct{})
	go func() {
		defer close(first)
		manager.RunTurn(ctx, host, sink, TurnInput{
			Session: "probe", AgentID: "devin",
			Message: "回复 ok 即可，不要使用任何工具。",
		}, "msg", false, "probe")
	}()
	select {
	case <-first:
	case <-time.After(180 * time.Second):
		t.Fatal("first turn never completed")
	}
	sink.mu.Lock()
	sink.events, sink.raw = nil, nil
	sink.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		manager.RunTurn(ctx, host, sink, TurnInput{
			Session: "probe", AgentID: "devin",
			Message: "请使用 ask_user_question 工具问我一个问题（选项随便给两个）。",
		}, "msg", false, "probe")
	}()
	event := sink.waitFor("elicitation", 120*time.Second)
	if event == nil {
		sink.mu.Lock()
		seen := append([]string(nil), sink.events...)
		sink.mu.Unlock()
		t.Fatalf("no elicitation event; seen events: %v", seen)
	}
	data, _ := json.Marshal(event)
	fmt.Printf("elicitation event: %s\n", data)
	id, _ := event["elicitationRequestId"].(string)
	if id == "" {
		t.Fatalf("elicitation missing id: %s", data)
	}
	meta, _ := event["meta"].(map[string]any)
	if meta["cognition.ai/allowOther"] != true {
		t.Fatalf("devin elicitation should advertise allowOther; event: %s", data)
	}
	schema, _ := event["schema"].(map[string]any)
	props, _ := schema["properties"].(map[string]any)
	content := map[string]any{}
	for name, raw := range props {
		field, _ := raw.(map[string]any)
		// 走 Other：提交枚举之外的自定义值，验证 allowOther 校验放行。
		if field["type"] == "array" {
			content[name] = []any{"自定义的其他回答"}
			continue
		}
		content[name] = "自定义的其他回答"
	}
	if err := host.elicit.Resolve(id, "probe", "accept", content); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if complete := sink.waitFor("complete", 180*time.Second); complete == nil {
		t.Fatal("turn never completed")
	}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("RunTurn did not return")
	}
	sink.mu.Lock()
	fmt.Printf("all events: %v\n", sink.events)
	sink.mu.Unlock()
}

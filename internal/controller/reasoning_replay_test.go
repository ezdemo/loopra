package controller

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/provider"
)

// TestSessionEventsHidesReasoningReplay 证明审计镜像在磁盘上
// 保留推理续接的内部状态（adk_event 原样落盘），而
// /api/agent/history/events 的响应剥掉该命名空间，同时不影响
// 同部分上的其它元数据。
func TestSessionEventsHidesReasoningReplay(t *testing.T) {
	ts, key, a := sessServer(t)
	ctx := contextBG()
	created, err := a.Sessions.Create(ctx, createReq(a, "audit"))
	if err != nil {
		t.Fatal(err)
	}
	event := &session.Event{
		Author: "model", Timestamp: time.Now(),
		Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{
			Text: "想", Thought: true,
			PartMetadata: map[string]any{
				provider.ReasoningReplayMetadataKey: map[string]any{"scope": "s", "item": "opaque"},
				"loopra.keep":                       "保留",
			},
		}}},
	}
	if err := a.Sessions.AppendEvent(ctx, created.Session, event); err != nil {
		t.Fatal(err)
	}
	// 磁盘上的 append-only 审计镜像保留完整内部状态。
	raw, err := os.ReadFile(filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions", "audit.events"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), provider.ReasoningReplayMetadataKey) {
		t.Fatal(".events should keep the internal replay state on disk")
	}
	// API 响应剥掉续接命名空间，其它 partMetadata 保留。
	_, env := call(t, ts, http.MethodGet, "/api/agent/history/events?sessionName=audit", key, nil)
	rows, ok := env["data"].([]any)
	if !ok || len(rows) == 0 {
		t.Fatalf("events = %v", env["data"])
	}
	var blob map[string]any
	for _, r := range rows {
		row := r.(map[string]any)
		if ev, ok := row["adk_event"].(map[string]any); ok {
			blob = ev
		}
	}
	if blob == nil {
		t.Fatalf("no adk_event row in %v", rows)
	}
	parts := blob["content"].(map[string]any)["parts"].([]any)
	metadata := parts[0].(map[string]any)["partMetadata"].(map[string]any)
	if _, ok := metadata[provider.ReasoningReplayMetadataKey]; ok {
		t.Fatalf("audit API leaked replay state: %v", metadata)
	}
	if metadata["loopra.keep"] != "保留" {
		t.Fatalf("other part metadata lost: %v", metadata)
	}
}

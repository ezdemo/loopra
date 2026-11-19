package subagent

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/service/tools"
)

func fusionEvent(t *testing.T, author, role, text string) *session.Event {
	t.Helper()
	return &session.Event{
		ID:        "ev-" + text,
		Author:    author,
		Timestamp: time.Now(),
		LLMResponse: model.LLMResponse{
			Content: &genai.Content{Role: role, Parts: []*genai.Part{{Text: text}}},
		},
	}
}

func eventTexts(s session.Session) []string {
	var out []string
	for event := range s.Events().All() {
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			out = append(out, part.Text)
		}
	}
	return out
}

// TestFusionCheckpointRoundTrip 验证检查点跨"重启"（全新的内存
// 会话服务）续用：保存的事件连同动作在磁盘往返后按序回放；
// 作用域不匹配、文件缺失与损坏各有明确语义。
func TestFusionCheckpointRoundTrip(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), fusionCheckpointFile)

	store := session.InMemoryService()
	created, err := store.Create(ctx, &session.CreateRequest{
		AppName: "loopra", UserID: "default", SessionID: "fusion-scope-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range []*session.Event{
		fusionEvent(t, "user", "user", "first-fusion-brief"),
		fusionEvent(t, fusionAgentName, "model", "first-fusion-result"),
	} {
		if err := store.AppendEvent(ctx, created.Session, event); err != nil {
			t.Fatal(err)
		}
	}
	marked := fusionEvent(t, fusionAgentName, "model", "with-delta")
	marked.Actions.StateDelta = map[string]any{"k": "v"}
	if err := store.AppendEvent(ctx, created.Session, marked); err != nil {
		t.Fatal(err)
	}
	partial := fusionEvent(t, fusionAgentName, "model", "partial-token")
	partial.Partial = true
	if err := store.AppendEvent(ctx, created.Session, partial); err != nil {
		t.Fatal(err)
	}
	if err := saveFusionCheckpoint(ctx, path, "scope-a", store, created.Session); err != nil {
		t.Fatal(err)
	}

	// 全新内存服务读取同一磁盘检查点：事件按序回放，动作保留。
	fresh := session.InMemoryService()
	current, err := fresh.Create(ctx, &session.CreateRequest{
		AppName: "loopra", UserID: "default", SessionID: "fusion-scope-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := restoreFusionCheckpoint(ctx, path, "scope-a", fresh, current.Session); err != nil {
		t.Fatal(err)
	}
	got := eventTexts(current.Session)
	want := []string{"first-fusion-brief", "first-fusion-result", "with-delta"}
	if !slices.Equal(got, want) {
		t.Fatalf("replayed = %v, want %v", got, want)
	}
	var withDelta *session.Event
	for event := range current.Session.Events().All() {
		if len(event.Actions.StateDelta) > 0 {
			withDelta = event
		}
	}
	if withDelta == nil || withDelta.Actions.StateDelta["k"] != "v" {
		t.Fatalf("state delta not preserved: %+v", withDelta)
	}

	// 作用域不同：干净起步，不回放也不报错。
	other, err := fresh.Create(ctx, &session.CreateRequest{
		AppName: "loopra", UserID: "default", SessionID: "fusion-scope-b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := restoreFusionCheckpoint(ctx, path, "scope-b", fresh, other.Session); err != nil {
		t.Fatal(err)
	}
	if n := len(eventTexts(other.Session)); n != 0 {
		t.Fatalf("scope mismatch replayed %d events", n)
	}

	// 文件不存在：干净起步。
	if err := restoreFusionCheckpoint(ctx, filepath.Join(t.TempDir(), fusionCheckpointFile), "scope-a", fresh, other.Session); err != nil {
		t.Fatalf("missing checkpoint = %v", err)
	}

	// 文件损坏：报错且不覆盖旧内容。
	broken := filepath.Join(t.TempDir(), fusionCheckpointFile)
	if err := os.WriteFile(broken, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := restoreFusionCheckpoint(ctx, broken, "scope-a", fresh, other.Session); err == nil {
		t.Fatal("invalid checkpoint did not error")
	}
	raw, _ := os.ReadFile(broken)
	if string(raw) != "{not-json" {
		t.Fatal("broken checkpoint was overwritten")
	}

	// 语法合法但缺作用域同样报错，不会被当作作用域不匹配跳过。
	if err := os.WriteFile(broken, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := restoreFusionCheckpoint(ctx, broken, "scope-a", fresh, other.Session); err == nil {
		t.Fatal("scopeless checkpoint did not error")
	}
	raw, _ = os.ReadFile(broken)
	if string(raw) != "{}" {
		t.Fatal("scopeless checkpoint was overwritten")
	}

	// 取消的保存不会触碰已有检查点。
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := saveFusionCheckpoint(cancelled, path, "scope-b", store, created.Session); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled save = %v, want context.Canceled", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("cancelled save modified the checkpoint")
	}
}

// TestFusionReadOnlyCannotUseWritableAllowlistedTool Fusion 只读角色
// （explore）即使角色允许清单点名可写工具，也只拿到只读条目。
func TestFusionReadOnlyCannotUseWritableAllowlistedTool(t *testing.T) {
	reg := tools.NewRegistry(tools.FileTools(t.TempDir())...)
	r := Runner{Registry: reg}
	profile := Profile{StrictModel: true, ReadOnly: true, AllowedTools: []string{"read", "edit"}}
	var names []string
	for _, item := range r.subTools(profile, "test") {
		names = append(names, item.Name())
	}
	if !slices.Equal(names, []string{"read"}) {
		t.Fatalf("read-only Fusion tools = %v", names)
	}
}

package jsonl

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/sessiontestsuite"
)

func TestConformanceSuite(t *testing.T) {
	opts := sessiontestsuite.SuiteOptions{SupportsUserProvidedSessionID: true}
	sessiontestsuite.RunServiceTests(t, opts, func(t *testing.T) session.Service {
		return NewService(t.TempDir())
	})
}

func mustCreate(t *testing.T, svc *Service, id string) session.Session {
	t.Helper()
	resp, err := svc.Create(context.Background(), &session.CreateRequest{
		AppName: "a1b2c3", UserID: "default", SessionID: id,
	})
	if err != nil {
		t.Fatal(err)
	}
	return resp.Session
}

func mustGet(t *testing.T, svc *Service, id string) session.Session {
	t.Helper()
	got, err := svc.Get(context.Background(), &session.GetRequest{AppName: "a1b2c3", UserID: "default", SessionID: id})
	if err != nil {
		t.Fatal(err)
	}
	return got.Session
}

func TestEventToLinesAndBack(t *testing.T) {
	root := t.TempDir()
	svc := NewService(root)
	sess := mustCreate(t, svc, "demo")

	ts := time.UnixMilli(1770000000000)
	events := []*session.Event{
		{
			ID: "u1", Author: "user", Timestamp: ts,
			Content: genai.NewContentFromText("hello world", genai.RoleUser),
		},
		{
			ID: "m1", Author: "model", Timestamp: ts,
			Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{
				{Text: "thinking hard", Thought: true},
				{Text: "sure"},
				{FunctionCall: &genai.FunctionCall{ID: "call_1", Name: "echo", Args: map[string]any{"text": "hi"}}},
			}},
		},
		{
			ID: "t1", Author: "user", Timestamp: ts,
			Content: &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{
				{FunctionResponse: &genai.FunctionResponse{ID: "call_1", Name: "echo", Response: map[string]any{"result": "echoed: hi"}}},
			}},
		},
		{
			ID: "h1", Author: "user", Timestamp: ts,
			Content:        genai.NewContentFromText("[状态通知]", genai.RoleUser),
			CustomMetadata: map[string]any{"webHidden": true},
		},
	}
	for _, ev := range events {
		if err := svc.AppendEvent(context.Background(), sess, ev); err != nil {
			t.Fatal(err)
		}
	}

	// 原始文件必须符合 Java 的 snake_case 格式。
	raw, err := os.ReadFile(filepath.Join(root, "workspace", "a1b2c3", "sessions", "demo.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 4 {
		t.Fatalf("lines = %d: %s", len(lines), raw)
	}
	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first["role"] != "user" || first["content"] != "hello world" {
		t.Fatalf("user line = %+v", first)
	}
	if first["timestamp"] != float64(1770000000000) {
		t.Fatalf("timestamp = %v", first["timestamp"])
	}
	var second map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	if second["role"] != "assistant" || second["reasoning_content"] != "thinking hard" || second["content"] != "sure" {
		t.Fatalf("assistant line = %+v", second)
	}
	calls := second["tool_calls"].([]any)
	call := calls[0].(map[string]any)
	if call["id"] != "call_1" {
		t.Fatalf("call = %+v", call)
	}
	fn := call["function"].(map[string]any)
	if fn["arguments"] != `{"text":"hi"}` {
		t.Fatalf("arguments = %v", fn["arguments"])
	}
	var third map[string]any
	if err := json.Unmarshal([]byte(lines[2]), &third); err != nil {
		t.Fatal(err)
	}
	if third["role"] != "tool" || third["tool_call_id"] != "call_1" || third["content"] != "echoed: hi" {
		t.Fatalf("tool line = %+v", third)
	}
	var fourth map[string]any
	if err := json.Unmarshal([]byte(lines[3]), &fourth); err != nil {
		t.Fatal(err)
	}
	if fourth["web_hidden"] != true {
		t.Fatalf("web_hidden line = %+v", fourth)
	}
	// .events 镜像携带相同的行。
	mirror, err := os.ReadFile(filepath.Join(root, "workspace", "a1b2c3", "sessions", "demo.events"))
	if err != nil || string(mirror) != string(raw) {
		t.Fatalf(".events mirror mismatch: %v", err)
	}

	// 通过服务读回，并重建模型可见的历史记录。
	got, err := svc.Get(context.Background(), &session.GetRequest{AppName: "a1b2c3", UserID: "default", SessionID: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	evs := got.Session.Events()
	if evs.Len() != 4 {
		t.Fatalf("loaded events = %d", evs.Len())
	}
	if evs.At(0).Author != "user" || evs.At(0).Content.Parts[0].Text != "hello world" {
		t.Fatalf("loaded user event = %+v", evs.At(0))
	}
	m := evs.At(1)
	if m.Author != "model" || !m.Content.Parts[0].Thought || m.Content.Parts[0].Text != "thinking hard" {
		t.Fatalf("model event parts wrong: %+v", m.Content.Parts)
	}
	if fc := m.Content.Parts[2].FunctionCall; fc == nil || fc.ID != "call_1" || fc.Args["text"] != "hi" {
		t.Fatalf("function call part = %+v", m.Content.Parts[2])
	}
	fr := evs.At(2).Content.Parts[0].FunctionResponse
	if fr == nil || fr.ID != "call_1" || fr.Response["result"] != "echoed: hi" {
		t.Fatalf("function response part = %+v", fr)
	}
	if evs.At(3).CustomMetadata["webHidden"] != true {
		t.Fatal("webHidden metadata lost")
	}
	if evs.At(0).ID != "u1" {
		t.Fatalf("event id = %q", evs.At(0).ID)
	}
}

func TestJavaFileInteroperability(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "workspace", "a1b2c3", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Java 后端写入的文件（snake_case，无事件 ID）。
	java := `{"role":"user","content":"java says hi","rollback_id":"ab12cd34","timestamp":1770000001000}
{"role":"assistant","content":"go here","reasoning_content":"ponder","tool_calls":[{"id":"c9","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}],"timestamp":1770000002000}
{"role":"tool","tool_call_id":"c9","content":"file1\nfile2","tool_duration_ms":120,"timestamp":1770000003000}
`
	if err := os.WriteFile(filepath.Join(dir, "from-java.jsonl"), []byte(java), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewService(root)
	got, err := svc.Get(context.Background(), &session.GetRequest{AppName: "a1b2c3", UserID: "default", SessionID: "from-java"})
	if err != nil {
		t.Fatal(err)
	}
	evs := got.Session.Events()
	if evs.Len() != 3 {
		t.Fatalf("events = %d", evs.Len())
	}
	if evs.At(0).Content.Parts[0].Text != "java says hi" {
		t.Fatalf("user text = %+v", evs.At(0).Content)
	}
	m := evs.At(1)
	if m.Author != "model" || !m.Content.Parts[0].Thought || m.Content.Parts[0].Text != "ponder" {
		t.Fatalf("assistant = %+v", m.Content)
	}
	fc := m.Content.Parts[2].FunctionCall
	if fc == nil || fc.ID != "c9" || fc.Args["command"] != "ls" {
		t.Fatalf("call = %+v", fc)
	}
	fr := evs.At(2).Content.Parts[0].FunctionResponse
	if fr == nil || fr.ID != "c9" || fr.Response["result"] != "file1\nfile2" {
		t.Fatalf("tool result = %+v", fr)
	}
	// 从 Go 侧追加会扩展 Java 文件，而不是替换它。
	if err := svc.AppendEvent(context.Background(), got.Session, &session.Event{
		ID: "go1", Author: "model", Timestamp: time.UnixMilli(1770000004000),
		Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: "appended"}}},
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "from-java.jsonl"))
	if strings.Count(string(raw), "\n") != 4 {
		t.Fatalf("appended lines = %d", strings.Count(string(raw), "\n"))
	}
	var last map[string]any
	_ = json.Unmarshal([]byte(strings.SplitN(string(raw), "\n", 4)[3]), &last)
	if last["role"] != "assistant" || last["content"] != "appended" || last["event_id"] != "go1" {
		t.Fatalf("appended line = %+v", last)
	}
}

func TestUsageAccounting(t *testing.T) {
	root := t.TempDir()
	svc := NewService(root)
	sess := mustCreate(t, svc, "usage")
	for _, text := range []string{"a", "b"} {
		u := &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 100, CandidatesTokenCount: 40, CachedContentTokenCount: 30}
		if text == "b" {
			u = &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 50, CandidatesTokenCount: 10}
		}
		if err := svc.AppendEvent(context.Background(), sess, &session.Event{
			ID: "e" + text, Author: "model", ModelVersion: "m-x", UsageMetadata: u,
			Content: &genai.Content{Parts: []*genai.Part{{Text: text}}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(root, "workspace", "a1b2c3", "sessions", "usage.usage"))
	if err != nil {
		t.Fatal(err)
	}
	var u map[string]int64
	if err := json.Unmarshal(raw, &u); err != nil {
		t.Fatal(err)
	}
	// prompt 150，completion 50，hit 30，miss 120，lastPrompt 50。
	if u["prompt"] != 150 || u["completion"] != 50 || u["cacheHit"] != 30 || u["cacheMiss"] != 120 || u["lastPromptTokens"] != 50 {
		t.Fatalf("usage = %+v", u)
	}
	mraw, err := os.ReadFile(filepath.Join(root, "workspace", "a1b2c3", "sessions", "usage.model_usage"))
	if err != nil {
		t.Fatal(err)
	}
	var mu map[string][4]int64
	if err := json.Unmarshal(mraw, &mu); err != nil {
		t.Fatal(err)
	}
	if got := mu["m-x"]; got != [4]int64{150, 50, 30, 120} {
		t.Fatalf("model usage = %+v", got)
	}
}

func TestCompactionSurvivesRoundTrip(t *testing.T) {
	root := t.TempDir()
	svc := NewService(root)
	sess := mustCreate(t, svc, "compact")
	comp := &session.EventCompaction{}
	if err := svc.AppendEvent(context.Background(), sess, &session.Event{
		ID: "c1", Author: "model",
		Actions: session.EventActions{Compaction: comp},
	}); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, svc, "compact")
	if got.Events().Len() != 1 {
		t.Fatalf("events = %d", got.Events().Len())
	}
	if got.Events().At(0).Actions.Compaction == nil {
		t.Fatal("compaction record lost on round trip")
	}
}

// Create 只在内存中登记会话，首个事件写入时才创建日志文件
// （对齐 Java 的延迟创建，避免空白会话产生空文件）。
func TestCreateMaterializesOnlyOnFirstEvent(t *testing.T) {
	root := t.TempDir()
	svc := NewService(root)
	sess := mustCreate(t, svc, "blank")
	path := filepath.Join(root, "workspace", "a1b2c3", "sessions", "blank.jsonl")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("Create wrote an empty session log: %v", err)
	}
	if err := svc.AppendEvent(context.Background(), sess, &session.Event{
		ID: "x1", Author: "user", Content: genai.NewContentFromText("hi", genai.RoleUser),
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), `"hi"`) {
		t.Fatalf("first event did not materialize the log: %v %q", err, raw)
	}
}

func TestDeleteAndList(t *testing.T) {
	root := t.TempDir()
	svc := NewService(root)
	mustCreate(t, svc, "alpha")
	mustCreate(t, svc, "beta")
	if err := svc.AppendEvent(context.Background(), mustGet(t, svc, "alpha"), &session.Event{
		ID: "x1", Author: "user", Content: genai.NewContentFromText("hi", genai.RoleUser),
	}); err != nil {
		t.Fatal(err)
	}
	list, err := svc.List(context.Background(), &session.ListRequest{AppName: "a1b2c3", UserID: "default"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Sessions) != 2 {
		t.Fatalf("sessions = %d", len(list.Sessions))
	}
	if err := svc.Delete(context.Background(), &session.DeleteRequest{AppName: "a1b2c3", UserID: "default", SessionID: "alpha"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(context.Background(), &session.GetRequest{AppName: "a1b2c3", UserID: "default", SessionID: "alpha"}); err == nil {
		t.Fatal("expected ErrNotFound after delete")
	}
	list, err = svc.List(context.Background(), &session.ListRequest{AppName: "a1b2c3", UserID: "default"})
	if err != nil || len(list.Sessions) != 1 {
		t.Fatalf("after delete sessions = %d err = %v", len(list.Sessions), err)
	}
}

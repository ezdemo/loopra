package controller

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

// 用量端点随压缩变化：被检查点覆盖的历史不再计入估算，
// 摘要调用自身的用量不得伪装成对话 prompt 水位。
func TestUsageReflectsCompaction(t *testing.T) {
	ts, key, a := sessServer(t)
	ctx := contextBG()
	sess, err := a.Session(ctx, "meter")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().Add(-time.Hour)
	appendEv := func(ev *session.Event) {
		t.Helper()
		if err := a.Sessions.AppendEvent(ctx, sess, ev); err != nil {
			t.Fatal(err)
		}
	}
	user := func(id, text string, at time.Time) *session.Event {
		return &session.Event{ID: id, Author: "user", Timestamp: at, Content: genai.NewContentFromText(text, genai.RoleUser)}
	}
	// 覆盖区：三条各 200 字符的旧消息，其中一条带实测用量。
	for i := range 3 {
		ev := user(fmt.Sprintf("old-%d", i), strings.Repeat("x", 200), base.Add(time.Duration(i)*time.Second))
		if i == 1 {
			ev.Author = "model"
			ev.Content = genai.NewContentFromText(strings.Repeat("y", 200), genai.RoleModel)
			ev.UsageMetadata = &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 50000}
		}
		appendEv(ev)
	}
	// 检查点覆盖三条旧消息；摘要调用自身花了 200000 tokens。
	appendEv(&session.Event{
		ID: "ckpt", Author: "loopra", Timestamp: base.Add(3 * time.Second),
		UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 200000, CandidatesTokenCount: 1000},
		Actions: session.EventActions{Compaction: &session.EventCompaction{
			StartTimestamp:   base,
			EndTimestamp:     base.Add(2 * time.Second),
			CompactedContent: genai.NewContentFromText("123456789012345678", genai.RoleModel),
		}},
	})
	appendEv(user("tail", "hello", base.Add(4*time.Second)))

	code, env := call(t, ts, http.MethodGet, "/api/usage?workspaceHash=ses0000001&sessionName=meter", key, nil)
	if code != http.StatusOK {
		t.Fatalf("status=%d env=%v", code, env)
	}
	data := env["data"].(map[string]any)
	// 摘要调用的 200k 不得覆盖最后对话 prompt 的 50k。
	if data["lastPromptTokens"].(float64) != 50000 {
		t.Fatalf("lastPromptTokens=%v", data["lastPromptTokens"])
	}
	// 压缩刚落盘，实测仍是旧结构：measuredFresh 必须为 false。
	if data["measuredFresh"] != false {
		t.Fatalf("measuredFresh=%v", data["measuredFresh"])
	}
	estimate := data["contextEstimate"].(map[string]any)
	// 覆盖区的 600 字符不再计入：用户消息只剩 tail 的 "hello"。
	if estimate["userTokens"].(float64) != 2 {
		t.Fatalf("userTokens=%v", estimate["userTokens"])
	}
	// 摘要 18 字符计入助手一次。
	if estimate["assistantTokens"].(float64) != 5 {
		t.Fatalf("assistantTokens=%v", estimate["assistantTokens"])
	}

	// 新一轮对话事件上报用量后，实测重新生效。
	fresh := user("reply", "hi there", base.Add(5*time.Second))
	fresh.Author = "model"
	fresh.Content = genai.NewContentFromText("hi there", genai.RoleModel)
	fresh.UsageMetadata = &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 17860}
	appendEv(fresh)
	_, env = call(t, ts, http.MethodGet, "/api/usage?workspaceHash=ses0000001&sessionName=meter", key, nil)
	data = env["data"].(map[string]any)
	if data["measuredFresh"] != true {
		t.Fatalf("measuredFresh after reply=%v", data["measuredFresh"])
	}
	if data["lastPromptTokens"].(float64) != 17860 {
		t.Fatalf("lastPromptTokens after reply=%v", data["lastPromptTokens"])
	}
}

// 撤回历史后实测 prompt 必须跟随仍保留的事件，而不是 .usage
// 计数器里的旧值；累计用量本身不随撤回回滚。
func TestUsageReflectsRollback(t *testing.T) {
	ts, key, a := sessServer(t)
	sess, err := a.Session(t.Context(), "rewind-meter")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	prompts := []int32{100, 9000}
	for i := range 4 {
		at := base.Add(time.Duration(i) * time.Second)
		var ev *session.Event
		if i%2 == 0 {
			ev = &session.Event{
				ID: fmt.Sprintf("request-%d", i/2), Author: "user", Timestamp: at,
				Content: genai.NewContentFromText("request", genai.RoleUser),
			}
		} else {
			ev = &session.Event{
				ID: fmt.Sprintf("reply-%d", i/2), Author: "model", Timestamp: at,
				Content:       genai.NewContentFromText("reply", genai.RoleModel),
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: prompts[i/2]},
			}
		}
		if err := a.Sessions.AppendEvent(t.Context(), sess, ev); err != nil {
			t.Fatal(err)
		}
	}
	assertUsage := func(want int, fresh bool) {
		t.Helper()
		code, env := call(t, ts, http.MethodGet, "/api/usage?workspaceHash=ses0000001&sessionName=rewind-meter", key, nil)
		if code != http.StatusOK {
			t.Fatalf("status=%d env=%v", code, env)
		}
		data := env["data"].(map[string]any)
		if data["lastPromptTokens"].(float64) != float64(want) {
			t.Fatalf("lastPromptTokens=%v want %d", data["lastPromptTokens"], want)
		}
		if data["measuredFresh"] != fresh {
			t.Fatalf("measuredFresh=%v want %v", data["measuredFresh"], fresh)
		}
		if data["promptTokens"].(float64) != 9100 {
			t.Fatalf("promptTokens=%v", data["promptTokens"])
		}
	}
	rollback := func(at time.Time) {
		t.Helper()
		code, env := call(t, ts, http.MethodPost, "/api/snapshots/rollback?workspaceHash=ses0000001", key,
			map[string]any{"sessionName": sess.ID(), "rollbackTimestamp": at.UnixMilli(), "rollbackCode": false})
		if code != http.StatusOK || env["success"] != true {
			t.Fatalf("rollback status=%d env=%v", code, env)
		}
	}
	assertUsage(9000, true)
	rollback(base.Add(2 * time.Second))
	assertUsage(100, true)
	rollback(base)
	assertUsage(0, false)
}

// 用量读取是只读的：Native 估算应用已保存的工具结果投影，但绝不
// 通过 projectedSessions.Get 为旧日志补写投影决策记录。
func TestUsageUsesSavedToolProjectionWithoutWriting(t *testing.T) {
	ts, key, a := sessServer(t)
	sess, err := a.Session(t.Context(), "projected-meter")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	if err := a.Sessions.AppendEvent(t.Context(), sess, &session.Event{
		ID: "plain", Author: "user", Timestamp: base,
		Content: genai.NewContentFromText("hello", genai.RoleUser),
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.Sessions.AppendEvent(t.Context(), sess, &session.Event{
		ID: "ckpt", Author: "loopra", Timestamp: base.Add(time.Second),
		Actions: session.EventActions{Compaction: &session.EventCompaction{
			StartTimestamp: base, EndTimestamp: base,
			CompactedContent: genai.NewContentFromText("folded", genai.RoleModel),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	runtime, err := agentpkg.NewContextRuntime(a.Model, a.Config(), a.Root.Name())
	if err != nil {
		t.Fatal(err)
	}
	projected := runtime.SessionService(a.Sessions, a.Config())
	if err := projected.AppendEvent(t.Context(), sess, &session.Event{
		ID: "projected-result", Author: "user", Timestamp: base.Add(2 * time.Second),
		LLMResponse: model.LLMResponse{Content: &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{
			{FunctionResponse: &genai.FunctionResponse{ID: "large", Name: "probe", Response: map[string]any{"result": strings.Repeat("z", 40000)}}},
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	// 旧日志中未投影的小结果：若 GET 走 projectedSessions.Get，
	// ensure 会为它补写一条新的决策记录，下面文件对比会失败。
	if err := a.Sessions.AppendEvent(t.Context(), sess, &session.Event{
		ID: "legacy-result", Author: "user", Timestamp: base.Add(3 * time.Second),
		LLMResponse: model.LLMResponse{Content: &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{
			{FunctionResponse: &genai.FunctionResponse{ID: "small", Name: "probe", Response: map[string]any{"result": "legacy result"}}},
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.Sessions.Root(), "workspace", a.App(), "sessions")
	jsonlBefore, err := os.ReadFile(filepath.Join(dir, sess.ID()+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	eventsBefore, err := os.ReadFile(filepath.Join(dir, sess.ID()+".events"))
	if err != nil {
		t.Fatal(err)
	}

	code, env := call(t, ts, http.MethodGet, "/api/usage?workspaceHash=ses0000001&sessionName=projected-meter", key, nil)
	if code != http.StatusOK {
		t.Fatalf("status=%d env=%v", code, env)
	}
	data := env["data"].(map[string]any)
	if data["measuredFresh"] != false {
		t.Fatalf("measuredFresh=%v", data["measuredFresh"])
	}
	estimate := data["contextEstimate"].(map[string]any)
	// 保留的投影有约 5000 字符：既不能漏计，也不能按 4 万字符原文计入。
	if got := estimate["toolResultTokens"].(float64); got <= 1000 || got >= 3000 {
		t.Fatalf("toolResultTokens=%v", got)
	}
	jsonlAfter, err := os.ReadFile(filepath.Join(dir, sess.ID()+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	eventsAfter, err := os.ReadFile(filepath.Join(dir, sess.ID()+".events"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(jsonlBefore, jsonlAfter) {
		t.Fatal("GET /api/usage 改写了 .jsonl")
	}
	if !bytes.Equal(eventsBefore, eventsAfter) {
		t.Fatal("GET /api/usage 改写了 .events")
	}
}

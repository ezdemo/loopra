//go:build !386 && !arm

package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContextLensCapturesScopesAndBoundsRealRuntime(t *testing.T) {
	h := New(t.TempDir(), Hooks{Services: map[string]ServiceHandler{"sessions": func(context.Context, string, map[string]any) (any, error) {
		return map[string]any{"messages": []any{}}, nil
	}}})
	view, err := h.Install(context.Background(), filepath.Join(findBundledRoot(), "context-lens"))
	if err != nil {
		t.Fatal(err)
	}
	if view.Panel == nil || view.Panel.Title != "透镜" || view.Sidebar != nil || len(view.Tools) != 0 {
		t.Fatalf("view=%+v", view)
	}
	selection := PageContext{WorkspaceHash: "project", SessionID: "project/conversation"}
	input := map[string]any{"app": "project", "sessionId": "conversation", "protocol": "chat_completions", "requestBytes": 123,
		"foldableCalls": []string{"call-one"}, "body": map[string]any{"model": "fixture", "messages": []any{
			map[string]any{"role": "system", "content": "ACTUAL PROJECT RULES"},
			map[string]any{"role": "user", "content": "inspect"},
			map[string]any{"role": "tool", "tool_call_id": "call-one", "content": "large tool output"},
		}}}
	for range 20 {
		h.RunObserver(context.Background(), HookLLMRequestSent, input)
	}
	list, err := h.Request(context.Background(), view.ID, "list", nil, selection)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(list)
	var summaries struct {
		Records []struct {
			ID string `json:"id"`
		} `json:"records"`
	}
	if json.Unmarshal(raw, &summaries) != nil || len(summaries.Records) != 16 {
		t.Fatalf("list=%s", raw)
	}
	detail, err := h.Request(context.Background(), view.ID, "detail", map[string]any{"id": summaries.Records[0].ID}, selection)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(detail)
	if !strings.Contains(string(raw), "ACTUAL PROJECT RULES") || !strings.Contains(string(raw), `"foldable":true`) {
		t.Fatalf("snapshot=%s", raw)
	}
	if _, err := h.Request(context.Background(), view.ID, "detail", map[string]any{"id": summaries.Records[0].ID}, PageContext{WorkspaceHash: "other"}); err == nil {
		t.Fatal("snapshot leaked across workspaces")
	}
	config := map[string]any{"rules": []any{map[string]any{"key": `["project","conversation"]`, "note": "PINNED", "folded": []string{"call-one"}}}}
	if err := h.SetUIConfig(view.ID, config); err != nil {
		t.Fatal(err)
	}
	rewritten, touched := h.RunHook(context.Background(), HookLLMRequest, map[string]any{"app": "project", "sessionId": "conversation", "system": "BASE"}, nil)
	if !touched["system"] || !strings.Contains(rewritten["system"].(string), "PINNED") || !touched["foldToolResults"] {
		t.Fatalf("rewrite=%v", rewritten)
	}
	if _, touched := h.RunHook(context.Background(), HookLLMRequest, map[string]any{"app": "project", "sessionId": "other", "system": "BASE"}, nil); touched["system"] {
		t.Fatal("pin leaked to another session")
	}
	if _, err := h.Request(context.Background(), view.ID, "clear", nil, selection); err != nil {
		t.Fatal(err)
	}
	list, _ = h.Request(context.Background(), view.ID, "list", nil, selection)
	raw, _ = json.Marshal(list)
	if !strings.Contains(string(raw), `"records":[]`) {
		t.Fatalf("clear=%s", raw)
	}
}

func TestContextLensHistoryFallbackAndDurableSnapshots(t *testing.T) {
	ctx, home := context.Background(), t.TempDir()
	historyReads := 0
	h := New(home, Hooks{Services: map[string]ServiceHandler{"sessions": func(_ context.Context, action string, value map[string]any) (any, error) {
		historyReads++
		if action != "history" || value["workspaceHash"] != "project" || value["sessionName"] != "old" {
			return map[string]any{"messages": []any{}}, nil
		}
		if value["revision"] == "r1" {
			return map[string]any{"unchanged": true}, nil
		}
		return map[string]any{"revision": "r1", "at": 1234, "agentId": "magpie", "native": false, "messages": []any{
			map[string]any{"role": "user", "content": "OLD USER"},
			map[string]any{"role": "assistant", "content": "OLD ANSWER", "reasoning_content": "SAVED REASONING"},
		}}, nil
	}}})
	view, err := h.Install(ctx, filepath.Join(findBundledRoot(), "context-lens"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.SetEnabled(ctx, view.ID, false)
	scope := PageContext{WorkspaceHash: "project", SessionID: "project/old"}
	list := func() map[string]any {
		t.Helper()
		out, err := h.Request(ctx, view.ID, "list", nil, scope)
		if err != nil {
			t.Fatal(err)
		}
		return out.(map[string]any)
	}
	rows := list()["records"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["origin"] != "history" {
		t.Fatalf("history=%v", rows)
	}
	historyID := rows[0].(map[string]any)["id"]
	detail, err := h.Request(ctx, view.ID, "detail", map[string]any{"id": historyID}, scope)
	raw, _ := json.Marshal(detail)
	if err != nil || !strings.Contains(string(raw), "OLD ANSWER") || !strings.Contains(string(raw), "SAVED REASONING") || !strings.Contains(string(raw), `"native":false`) {
		t.Fatalf("detail=%s err=%v", raw, err)
	}
	if _, err := h.Request(ctx, view.ID, "detail", map[string]any{"id": historyID}, PageContext{WorkspaceHash: "other", SessionID: "other/old"}); err == nil {
		t.Fatal("history leaked across workspaces")
	}
	h.RunObserver(ctx, HookLLMRequestSent, map[string]any{"app": "project", "sessionId": "old", "body": map[string]any{"messages": []any{map[string]any{"role": "user", "content": "REAL REQUEST"}}}})
	rows = list()["records"].([]any)
	id := rows[0].(map[string]any)["id"]
	if rows[0].(map[string]any)["origin"] != "request" {
		t.Fatal("actual request must take precedence over history")
	}
	if _, err := os.Stat(filepath.Join(h.dataDir(view.ID), "requests.json")); err != nil {
		t.Fatal("snapshot was not persisted:", err)
	}
	readsBeforeReload := historyReads
	if _, err := h.SetEnabled(ctx, view.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := h.SetEnabled(ctx, view.ID, true); err != nil {
		t.Fatal(err)
	}
	rows = list()["records"].([]any)
	if rows[0].(map[string]any)["id"] != id || historyReads != readsBeforeReload {
		t.Fatalf("request did not survive backend reload: %v", rows)
	}
	detail, err = h.Request(ctx, view.ID, "detail", map[string]any{"id": id}, scope)
	raw, _ = json.Marshal(detail)
	if err != nil || !strings.Contains(string(raw), "REAL REQUEST") {
		t.Fatalf("restored detail=%s err=%v", raw, err)
	}
	if _, err := h.Request(ctx, view.ID, "clear", nil, scope); err != nil {
		t.Fatal(err)
	}
	rows = list()["records"].([]any)
	if rows[0].(map[string]any)["origin"] != "history" {
		t.Fatal("clearing snapshots must preserve conversation history")
	}
}

func TestRequestObserversCannotRewriteEachOthersEvidence(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	installPageBackend(t, h, "observer-one", `export function llmRequestSent(input) {
  input.body.messages[0].content = "tampered";
  return { body: { messages: [{content: "replacement"}] } };
}`, nil)
	view := installPageBackend(t, h, "observer-two", `let seen = "";
export function llmRequestSent(input) { seen = input.body.messages[0].content; }
export function onRequest() { return { seen }; }`, nil)
	message := map[string]any{"content": "actual"}
	h.RunObserver(context.Background(), HookLLMRequestSent, map[string]any{"body": map[string]any{"messages": []any{message}}})
	out, err := h.Request(context.Background(), view.ID, "read", nil)
	if err != nil || out.(map[string]any)["seen"] != "actual" || message["content"] != "actual" {
		t.Fatalf("observer changed evidence: %v %v original=%v", out, err, message)
	}
}

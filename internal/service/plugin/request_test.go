//go:build !386 && !arm

package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func installPageBackend(t *testing.T, h *Host, name, source string, services []string) View {
	t.Helper()
	dir := t.TempDir()
	manifest, _ := json.Marshal(map[string]any{"name": name, "loopra": map[string]any{"plugin": "plugin.js", "services": services}})
	for file, data := range map[string][]byte{"package.json": manifest, "plugin.js": []byte(source)} {
		if err := os.WriteFile(filepath.Join(dir, file), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	view, err := h.Install(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func TestPageBackendDispatchConfigContextAndIsolation(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	view := installPageBackend(t, h, "page-one", `
 export async function onRequest(input) {
   if (input.action === "fail") throw new Error("expected failure");
   if (input.action !== "read") throw new Error("unknown action");
   await new Promise(resolve => setTimeout(resolve, 1));
   return { value: input.value, config: input.config, context: input.context };
 }`, nil)
	if !view.Requests || len(view.Tools) != 0 {
		t.Fatalf("handler was registered as a tool: %+v", view)
	}
	if err := h.SetUIConfig(view.ID, map[string]any{"owner": "one"}); err != nil {
		t.Fatal(err)
	}
	other := installPageBackend(t, h, "page-two", `export default { onRequest(input) { return { owner: "two" }; } };`, nil)
	selection := PageContext{WorkspaceHash: "project", WorkspaceDir: "/project", SessionID: "project/session", FilePath: "main.go"}
	out, err := h.Request(context.Background(), view.ID, "read", map[string]any{"plugin": other.ID, "config": map[string]any{"owner": "forged"}}, selection)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(out)
	var got struct {
		Config  map[string]any `json:"config"`
		Context PageContext    `json:"context"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Config["owner"] != "one" || got.Context != selection {
		t.Fatalf("payload=%s", raw)
	}
	if _, err = h.Request(context.Background(), view.ID, "fail", nil); err == nil || !strings.Contains(err.Error(), "expected failure") {
		t.Fatalf("failure=%v", err)
	}
	if _, err = h.Request(context.Background(), other.ID, "read", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Request(context.Background(), view.ID, "read", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = h.SetEnabled(context.Background(), view.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Request(context.Background(), view.ID, "read", nil); err == nil {
		t.Fatal("disabled handler remained callable")
	}
}

func TestPageBackendServicesAreDeclaredCapabilities(t *testing.T) {
	calls := 0
	h := New(t.TempDir(), Hooks{Services: map[string]ServiceHandler{"catalog": func(_ context.Context, action string, value map[string]any) (any, error) {
		calls++
		return map[string]any{"action": action, "query": value["query"]}, nil
	}}})
	source := `export function onRequest(input) { return loopra.services.request("catalog", input.action, input.value); }`
	allowed := installPageBackend(t, h, "third-party", source, []string{"catalog"})
	denied := installPageBackend(t, h, "undeclared", source, nil)
	if _, err := h.Request(context.Background(), allowed.ID, "search", map[string]any{"query": "hello"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Request(context.Background(), denied.ID, "search", nil); err == nil || !strings.Contains(err.Error(), "未声明") {
		t.Fatalf("undeclared service=%v", err)
	}
	if calls != 1 {
		t.Fatalf("host service invoked %d times", calls)
	}
}

func TestPageBackendDoesNotDispatchToolsAndRecoversAfterCancellation(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	view := installPageBackend(t, h, "actions", `
 let touched = false;
 export function dangerous() { touched = true; return {}; }
 export async function onRequest(input) {
   if (input.action === "wait") await new Promise(resolve => setTimeout(resolve, 10000));
   if (input.action === "dangerous") throw new Error("page cannot execute tools");
   return { touched };
 }`, nil)
	if len(view.Tools) != 1 || strings.Contains(view.Tools[0], "onRequest") {
		t.Fatalf("tools=%v", view.Tools)
	}
	if _, err := h.Request(context.Background(), view.ID, "dangerous", nil); err == nil {
		t.Fatal("tool dispatched through page")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := h.Request(ctx, view.ID, "wait", nil); err == nil {
		t.Fatal("request ignored cancellation")
	}
	out, err := h.Request(context.Background(), view.ID, "status", nil)
	if err != nil || out.(map[string]any)["touched"] != false {
		t.Fatalf("recovery=%v %v", out, err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("cancelled timer leaked into the next request")
	}
}

func TestPageBackendQueueRespectsCallerCancellation(t *testing.T) {
	started := make(chan struct{}, 1)
	h := New(t.TempDir(), Hooks{Services: map[string]ServiceHandler{"signal": func(context.Context, string, map[string]any) (any, error) {
		started <- struct{}{}
		return nil, nil
	}}})
	view := installPageBackend(t, h, "queued", `export async function onRequest(input) {
  if (input.action === "wait") {
    loopra.services.request("signal", "started", {});
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { ok: true };
}`, []string{"signal"})
	done := make(chan error, 1)
	go func() { _, err := h.Request(context.Background(), view.ID, "wait", nil); done <- err }()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := h.Request(ctx, view.ID, "read", nil); err == nil {
		t.Fatal("queued request ignored deadline")
	}
	if err := <-done; err != nil {
		t.Fatalf("queued cancellation interrupted running request: %v", err)
	}
	if _, err := h.Request(context.Background(), view.ID, "read", nil); err != nil {
		t.Fatal(err)
	}
}

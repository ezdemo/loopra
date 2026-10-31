package plugin

import (
	"context"
	"strings"
	"testing"
)

func TestHookOnlyModuleLoads(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	view := installJS(t, h, "hook-only", `
export function turnBefore(input) { return { message: input.message }; }
export function toolAfter(input) { return input; }
`)
	if view.State != "已启用" || len(view.Tools) != 0 {
		t.Fatalf("view = %+v", view)
	}
	if strings.Join(view.Hooks, ",") != "turnBefore,toolAfter" {
		t.Fatalf("hooks = %#v", view.Hooks)
	}
	if len(h.Bound()) != 0 {
		t.Fatalf("hook exports were registered as tools: %+v", h.Bound())
	}
}

func TestHookBesideTool(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	view := installJS(t, h, "hook-tool", `
export function greet() { return { text: "hi" }; }
export function turnBefore(input) { return { message: "x:" + input.message }; }
`)
	if len(view.Tools) != 1 || view.Tools[0] != "hook_tool__greet" {
		t.Fatalf("tools = %#v", view.Tools)
	}
	if strings.Join(view.Hooks, ",") != "turnBefore" {
		t.Fatalf("hooks = %#v", view.Hooks)
	}
	out, touched := h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": "hi"}, nil)
	if !touched["message"] || out["message"] != "x:hi" {
		t.Fatalf("hook = %#v touched=%v", out, touched)
	}
	called, err := h.Bound()[0].Call(context.Background(), map[string]any{})
	if err != nil || called["text"] != "hi" {
		t.Fatalf("tool = %#v %v", called, err)
	}
}

func TestHooksChainInInstallOrder(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	installJS(t, h, "hook-a", `export function turnBefore(input) { return { message: input.message + ":one" }; }`)
	installJS(t, h, "hook-b", `export function turnBefore(input) { return { message: input.message + ":two" }; }`)
	out, _ := h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": "hi"}, nil)
	if out["message"] != "hi:one:two" {
		t.Fatalf("chain = %#v", out["message"])
	}

	out, _ = h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": "hi"}, func(got map[string]any) bool {
		cancel, _ := got["cancel"].(bool)
		return cancel
	})
	if out["message"] != "hi:one:two" {
		t.Fatal("stop callback ran without a cancel decision")
	}
}

func TestSystemPromptAppendsAccumulateAndFeedNextHook(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	installJS(t, h, "prompt-a", `export function systemPrompt() { return { append: "A" }; }`)
	installJS(t, h, "prompt-b", `export function systemPrompt(input) { return { append: "[" + input.text + "]" }; }`)
	installJS(t, h, "prompt-invalid", `export function systemPrompt() { return { append: 42 }; }`)
	out, touched := h.RunHook(context.Background(), HookSystemPrompt, map[string]any{"text": "BASE"}, nil)
	if out["text"] != "BASE" || out["append"] != "A[BASEA]" || !touched["append"] || touched["text"] {
		t.Fatalf("prompt = %#v touched=%v", out, touched)
	}
}

func TestSystemPromptReplacementConsumesEarlierAppends(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	installJS(t, h, "prompt-a", `export function systemPrompt() { return { append: "A" }; }`)
	installJS(t, h, "prompt-b", `export function systemPrompt(input) { return { text: input.text + "B", append: "C" }; }`)
	installJS(t, h, "prompt-c", `export function systemPrompt() { return { append: "D" }; }`)
	out, _ := h.RunHook(context.Background(), HookSystemPrompt, map[string]any{"text": "BASE"}, nil)
	if out["text"] != "BASEAB" || out["append"] != "CD" {
		t.Fatalf("prompt = %#v", out)
	}
}

func TestHookPrioritiesArePerHookStableAndSurviveReload(t *testing.T) {
	home := t.TempDir()
	h := New(home, Hooks{})
	installJS(t, h, "priority-a", `
export const meta = {hookPriority: {systemPrompt: 10, turnBefore: -10}};
export function systemPrompt() { return {append: "A"}; }
export function turnBefore(input) { return {message: input.message + "A"}; }`)
	installJS(t, h, "priority-b", `
export function systemPrompt() { return {append: "B"}; }
export function turnBefore(input) { return {message: input.message + "B"}; }`)
	installJS(t, h, "priority-c", `
export const meta = {hookPriority: {systemPrompt: -10, turnBefore: 10}};
export function systemPrompt() { return {append: "C"}; }
export function turnBefore(input) { return {message: input.message + "C"}; }`)
	installJS(t, h, "priority-d", `
export const meta = {hookPriority: {systemPrompt: "invalid", turnBefore: 0.5}};
export function systemPrompt() { return {append: "D"}; }
export function turnBefore(input) { return {message: input.message + "D"}; }`)
	for round := 0; round < 2; round++ {
		out, _ := h.RunHook(context.Background(), HookSystemPrompt, map[string]any{"text": "BASE"}, nil)
		if out["append"] != "CBDA" {
			t.Fatalf("round %d prompt = %#v", round, out)
		}
		out, _ = h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": ""}, nil)
		if out["message"] != "ABDC" {
			t.Fatalf("round %d turn = %#v", round, out)
		}
		out, _ = h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": ""}, func(out map[string]any) bool { return out["message"] == "AB" })
		if out["message"] != "AB" {
			t.Fatalf("stop ignored: %#v", out)
		}
		h = New(home, Hooks{})
		h.LoadEnabled(context.Background())
	}
}

func TestHookThrowIsSkipped(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	installJS(t, h, "hook-bad", `export function turnBefore() { throw new Error("boom"); }`)
	second := installJS(t, h, "hook-ok", `export function turnBefore(input) { return { message: input.message + ":ok", cancel: true }; }`)
	out, touched := h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": "hi"}, func(got map[string]any) bool {
		cancel, _ := got["cancel"].(bool)
		return cancel
	})
	if !touched["cancel"] || out["message"] != "hi:ok" {
		t.Fatalf("after throw = %#v touched=%v", out, touched)
	}
	if _, err := h.SetEnabled(context.Background(), second.ID, false); err != nil {
		t.Fatal(err)
	}
	out, touched = h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": "hi"}, nil)
	if touched["message"] || out["message"] != "hi" {
		t.Fatalf("disabled plugin still ran: %#v touched=%v", out, touched)
	}
}

func TestDefaultExportHook(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	view := installJS(t, h, "hook-default", `
export default {
  turnBefore(input) { return { message: "via-default:" + input.message }; }
}
`)
	if len(view.Tools) != 0 || strings.Join(view.Hooks, ",") != "turnBefore" {
		t.Fatalf("view = %+v", view)
	}
	out, _ := h.RunHook(context.Background(), HookTurnBefore, map[string]any{"message": "hi"}, nil)
	if out["message"] != "via-default:hi" {
		t.Fatalf("default hook = %#v", out["message"])
	}
}

func installJS(t *testing.T, h *Host, name, source string) View {
	t.Helper()
	h.Fetcher = npmTar(t, name, "1.0.0", map[string]string{
		"package/package.json": `{"name":"` + name + `","version":"1.0.0","loopra":"./plugin.js"}`,
		"package/plugin.js":    source,
	})
	view, err := h.Install(context.Background(), name+"@1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	return view
}

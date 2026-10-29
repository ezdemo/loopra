package acp

import "testing"

func TestToolOutputPrefersTerminalAndReportsExit(t *testing.T) {
	out := &ToolOutput{}
	out.Update(nil, []ToolCallItem{{
		Type: "content", Content: &ContentBlock{Type: "text", Text: "content body"},
	}}, map[string]any{"terminal_output_delta": map[string]any{"data": "line-1\n"}})
	out.Update(nil, nil, map[string]any{"terminal_output": map[string]any{"data": "line-2\n"}})
	text := out.Text()
	if text != "line-1\nline-2\n" {
		t.Fatalf("text = %q", text)
	}
	if out.Failed() {
		t.Fatal("no exit information should not be failed")
	}
}

func TestToolOutputExitOnlySummary(t *testing.T) {
	out := &ToolOutput{}
	out.Update(map[string]any{"exit_code": float64(7)}, nil, map[string]any{"terminal_exit": map[string]any{"signal": "SIGTERM"}})
	if !out.Failed() {
		t.Fatal("nonzero exit must be failed")
	}
	text := out.Text()
	if text != "Exit code: 7, Signal: SIGTERM" {
		t.Fatalf("text = %q", text)
	}
}

func TestToolOutputTerminalBeatsRaw(t *testing.T) {
	out := &ToolOutput{}
	out.Update("raw body", nil, map[string]any{"terminal_output_delta": map[string]any{"data": "terminal body"}})
	if text := out.Text(); text != "terminal body" {
		t.Fatalf("text = %q", text)
	}
}

func TestToolOutputFallsBackToContentAndProgress(t *testing.T) {
	out := &ToolOutput{}
	out.Update(nil, []ToolCallItem{{
		Type: "content", Content: &ContentBlock{Type: "text", Text: "first"},
	}, {
		Type: "content", Content: &ContentBlock{Type: "text", Text: "second"},
	}}, nil)
	if text := out.Text(); text != "first\nsecond" {
		t.Fatalf("content text = %q", text)
	}
	progress := &ToolOutput{}
	progress.Update(nil, nil, map[string]any{"mcp_output_delta": map[string]any{"data": "progress"}})
	if text := progress.Text(); text != "progress" {
		t.Fatalf("progress text = %q", text)
	}
}

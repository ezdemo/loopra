package jsonl

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"
)

func TestAsyncResultCodecKeepsProtocolAndUIViews(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		ev := &session.Event{ID: "completion", Author: "loopra", Timestamp: time.Now()}
		ev.CustomMetadata = map[string]any{"asyncToolResult": map[string]any{
			"callId": "original", "name": "shell", "status": "completed", "response": map[string]any{"result": "evidence"},
		}}
		if automatic {
			ev.Content = genai.NewContentFromText("Tool completion notification: evidence", genai.RoleUser)
		}
		lines := eventLines(ev)
		if len(lines) != 1 || lines[0]["role"] != "tool" || lines[0]["tool_call_id"] != "original" || lines[0]["content"] != "evidence" || lines[0]["tool_status"] != "completed" {
			t.Fatalf("UI rows = %v", lines)
		}
		data, err := json.Marshal(lines[0])
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatal(err)
		}
		restored := lineEvent(decoded, 0)
		if restored.CustomMetadata["asyncToolResult"] == nil {
			t.Fatal("completion identity lost")
		}
		if automatic {
			if restored.Content == nil || !strings.Contains(restored.Content.Parts[0].Text, "evidence") || restored.Content.Parts[0].FunctionResponse != nil {
				t.Fatalf("protocol event = %v", restored.Content)
			}
		} else if restored.Content != nil {
			t.Fatal("queried result injected a second time")
		}
	}
}

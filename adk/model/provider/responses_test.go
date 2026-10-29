package provider

import (
	"net/http"
	"strings"
	"testing"

	"google.golang.org/genai"
)

func TestResponsesSync(t *testing.T) {
	srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi there"}]},{"type":"function_call","call_id":"call_2","name":"echo","arguments":"{\"text\":\"yo\"}"}],"usage":{"input_tokens":11,"output_tokens":6,"total_tokens":17,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":2}}}`))
	})
	llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{ReasoningEffort: "max"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, echoToolDecl()), false)
	if err != nil || len(out) != 1 {
		t.Fatalf("sync: %v len=%d", err, len(out))
	}
	final := out[0]
	if final.Content.Parts[0].Text != "hi there" {
		t.Fatalf("text = %+v", final.Content.Parts[0])
	}
	fc := final.Content.Parts[1].FunctionCall
	if fc.ID != "call_2" || fc.Name != "echo" || fc.Args["text"] != "yo" {
		t.Fatalf("call = %+v", fc)
	}
	if final.UsageMetadata.PromptTokenCount != 11 || final.UsageMetadata.CachedContentTokenCount != 4 || final.UsageMetadata.ThoughtsTokenCount != 2 {
		t.Fatalf("usage = %+v", final.UsageMetadata)
	}
	if (*body)["instructions"] != "be brief" {
		t.Fatalf("instructions = %v", (*body)["instructions"])
	}
	if (*body)["max_output_tokens"] != float64(1024) {
		t.Fatalf("max_output_tokens = %v", (*body)["max_output_tokens"])
	}
	// 推理强度 max 映射为 high。
	reasoning := (*body)["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %+v", reasoning)
	}
	input := (*body)["input"].([]any)
	first := input[0].(map[string]any)
	if first["type"] != "message" || first["role"] != "user" {
		t.Fatalf("input item = %+v", first)
	}
	tools := (*body)["tools"].([]any)
	if tools[0].(map[string]any)["name"] != "echo" {
		t.Fatalf("tool = %+v", tools[0])
	}
}

func TestResponsesToolRoundTrip(t *testing.T) {
	srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{}}`))
	})
	llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	contents := []*genai.Content{
		userContent("run"),
		{Role: genai.RoleModel, Parts: []*genai.Part{{
			FunctionCall: &genai.FunctionCall{ID: "call_1", Name: "echo", Args: map[string]any{"text": "hi"}},
		}}},
		{Role: genai.RoleUser, Parts: []*genai.Part{{
			FunctionResponse: &genai.FunctionResponse{ID: "call_1", Name: "echo", Response: map[string]any{"result": "hi"}},
		}}},
	}
	if _, err := collectLLM(llm, reqWith(contents), false); err != nil {
		t.Fatal(err)
	}
	input := (*body)["input"].([]any)
	if len(input) != 3 {
		t.Fatalf("input items = %d", len(input))
	}
	call := input[1].(map[string]any)
	if call["type"] != "function_call" || call["call_id"] != "call_1" || call["arguments"] != `{"text":"hi"}` {
		t.Fatalf("function_call item = %+v", call)
	}
	output := input[2].(map[string]any)
	if output["type"] != "function_call_output" || output["call_id"] != "call_1" || output["output"] != "hi" {
		t.Fatalf("output item = %+v", output)
	}
}

func TestResponsesStream(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{
			`event: response.output_text.delta` + "\n" + `data: {"type":"response.output_text.delta","delta":"he"}`,
			`event: response.output_text.delta` + "\n" + `data: {"type":"response.output_text.delta","delta":"y"}`,
			`event: response.output_item.added` + "\n" + `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_5","name":"echo"}}`,
			`event: response.function_call_arguments.delta` + "\n" + `data: {"type":"response.function_call_arguments.delta","delta":"{\"text\":\"z\"}"}`,
			`event: response.completed` + "\n" + `data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4},"output":[{"type":"message","content":[{"type":"output_text","text":"hey"}]},{"type":"function_call","call_id":"call_5","name":"echo","arguments":"{\"text\":\"z\"}"}]}}`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
		}
	})
	llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, echoToolDecl()), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 3 { // 2 个文本部分事件 + 最终响应
		t.Fatalf("events = %d", len(out))
	}
	if out[0].Content.Parts[0].Text != "he" || out[1].Content.Parts[0].Text != "y" {
		t.Fatalf("partials = %+v %+v", out[0], out[1])
	}
	final := out[2]
	if final.Partial || !final.TurnComplete {
		t.Fatalf("final flags: %+v", final)
	}
	fc := final.Content.Parts[1].FunctionCall
	if fc.ID != "call_5" || fc.Args["text"] != "z" {
		t.Fatalf("final call = %+v", fc)
	}
	if final.UsageMetadata.PromptTokenCount != 3 {
		t.Fatalf("usage = %+v", final.UsageMetadata)
	}
}

func TestResponsesStreamFailure(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: response.failed\n" + `data: {"type":"response.failed","error":{"message":"boom"}}` + "\n\n"))
	})
	llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), true)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected boom error, got %v", err)
	}
}

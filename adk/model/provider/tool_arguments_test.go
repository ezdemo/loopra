package provider

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/genai"
)

func TestMalformedToolArgumentsReplayPreservesRaw(t *testing.T) {
	const raw = `{"text":"broken" n}`
	for _, protocol := range []string{ProtocolChatCompletions, ProtocolResponses} {
		t.Run(protocol, func(t *testing.T) {
			srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				if protocol == ProtocolResponses {
					_, _ = w.Write([]byte(`{"status":"completed","output":[]}`))
				} else {
					_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"}}]}`))
				}
			})
			llm, err := NewLLM(testChannel(protocol, srv.URL), &Options{})
			if err != nil {
				t.Fatal(err)
			}
			part := toolCallPart(protocol, "echo", "call_bad", raw)
			// Simulate persisted/restored content, including metadata.
			data, err := json.Marshal(part)
			if err != nil {
				t.Fatal(err)
			}
			var restored genai.Part
			if err := json.Unmarshal(data, &restored); err != nil {
				t.Fatal(err)
			}
			_, err = collectLLM(llm, reqWith([]*genai.Content{
				userContent("run echo"),
				{Role: genai.RoleModel, Parts: []*genai.Part{&restored}},
				{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "call_bad", Name: "echo", Response: map[string]any{"error": ToolArgumentError(&restored)}}}}},
			}), false)
			if err != nil {
				t.Fatal(err)
			}
			var arguments any
			if protocol == ProtocolResponses {
				for _, item := range (*body)["input"].([]any) {
					call := item.(map[string]any)
					if call["type"] == "function_call" {
						arguments = call["arguments"]
					}
				}
			} else {
				messages := (*body)["messages"].([]any)
				call := messages[1].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
				arguments = call["function"].(map[string]any)["arguments"]
			}
			if arguments != raw {
				t.Fatalf("malformed arguments were replaced on replay: %v", arguments)
			}
		})
	}
}

func TestAdaptersRetainToolArgumentErrors(t *testing.T) {
	for _, test := range []struct {
		name, protocol, body string
		stream               bool
	}{
		{"chat-sync", ProtocolChatCompletions, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call_bad","type":"function","function":{"name":"rg","arguments":"{\"globs\": "}}]},"finish_reason":"tool_calls"}]}`, false},
		{"chat-stream", ProtocolChatCompletions, "data: " + `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"rg","arguments":"{\"globs\": "}}]}}]}` + "\n\ndata: [DONE]\n\n", true},
		{"responses-sync", ProtocolResponses, `{"status":"completed","output":[{"type":"function_call","call_id":"call_bad","name":"rg","arguments":"{\"globs\": "}]}`, false},
		{"responses-stream", ProtocolResponses, "data: " + `{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_bad","name":"rg","arguments":"{\"globs\": "}]}}` + "\n\n", true},
		{"anthropic-sync", ProtocolAnthropic, `{"role":"assistant","content":[{"type":"tool_use","id":"call_bad","name":"rg","input":[]}]}`, false},
		{"anthropic-stream", ProtocolAnthropic, "data: " + `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_bad","name":"rg","input":{}}}` + "\n\ndata: " + `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"globs\": "}}` + "\n\ndata: " + `{"type":"message_stop"}` + "\n\n", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
				contentType := "application/json"
				if test.stream {
					contentType = "text/event-stream"
				}
				w.Header().Set("Content-Type", contentType)
				_, _ = w.Write([]byte(test.body))
			})
			llm, err := NewLLM(testChannel(test.protocol, srv.URL), &Options{})
			if err != nil {
				t.Fatal(err)
			}
			out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("search")}), test.stream)
			if err != nil {
				t.Fatalf("argument failure terminated the response: %v", err)
			}
			found := false
			for _, resp := range out {
				if resp.Content == nil {
					continue
				}
				for _, part := range resp.Content.Parts {
					if part.FunctionCall != nil {
						found = true
						message := ToolArgumentError(part)
						if !strings.Contains(message, "arguments JSON") || !strings.Contains(message, "call_bad") || !strings.Contains(message, "retry") {
							t.Fatalf("missing actionable argument error: %q", message)
						}
						if part.FunctionCall.ID != "call_bad" || part.FunctionCall.Name != "rg" || len(part.FunctionCall.Args) != 0 {
							t.Fatalf("unsafe or unidentifiable tool call: %+v", part.FunctionCall)
						}
					}
				}
			}
			if !found {
				t.Fatal("lost the failed tool call")
			}
		})
	}
}

func TestToolArgumentsRequireObject(t *testing.T) {
	for _, raw := range []string{"null", "[]", `"text"`, "3", `{"globs":`} {
		t.Run(raw, func(t *testing.T) {
			if _, err := toolArguments("chat completions", "rg", "call_bad", raw); err == nil {
				t.Fatalf("accepted non-object or malformed arguments: %s", raw)
			}
		})
	}
	for _, raw := range []string{"", "{}"} {
		if args, err := toolArguments("chat completions", "echo", "call_empty", raw); err != nil || args == nil || len(args) != 0 {
			t.Fatalf("empty arguments = %v, %v", args, err)
		}
	}
}

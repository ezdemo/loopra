package provider

import (
	"net/http"
	"strings"
	"testing"

	"google.golang.org/genai"
)

func TestAdaptersRejectMalformedToolArguments(t *testing.T) {
	for _, test := range []struct {
		name, protocol, body string
		stream               bool
	}{
		{"chat-sync", ProtocolChatCompletions, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call_bad","type":"function","function":{"name":"rg","arguments":"{\"globs\": "}}]},"finish_reason":"tool_calls"}]}`, false},
		{"chat-stream", ProtocolChatCompletions, "data: " + `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"rg","arguments":"{\"globs\": "}}]}}]}` + "\n\ndata: [DONE]\n\n", true},
		{"responses-sync", ProtocolResponses, `{"status":"completed","output":[{"type":"function_call","call_id":"call_bad","name":"rg","arguments":"{\"globs\": "}]}`, false},
		{"responses-stream", ProtocolResponses, "data: " + `{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_bad","name":"rg","arguments":"{\"globs\": "}]}}` + "\n\n", true},
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
			if err == nil || !strings.Contains(err.Error(), "arguments JSON") || !strings.Contains(err.Error(), "call_bad") {
				t.Fatalf("expected identifiable argument parse error, got %v", err)
			}
			for _, resp := range out {
				if resp.Content == nil {
					continue
				}
				for _, part := range resp.Content.Parts {
					if part.FunctionCall != nil {
						t.Fatalf("malformed tool call was emitted: %+v", part.FunctionCall)
					}
				}
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

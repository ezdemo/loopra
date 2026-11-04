package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/provider"
	"github.com/ezdemo/looprax/internal/model/config"
)

func TestMalformedToolArgumentsAllowModelRecovery(t *testing.T) {
	for _, protocol := range []string{provider.ProtocolChatCompletions, provider.ProtocolResponses, provider.ProtocolAnthropic} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%v", protocol, stream), func(t *testing.T) {
				raw := `{"text":"broken" n}`
				if protocol == provider.ProtocolAnthropic && !stream {
					// A sync Messages envelope must itself be valid JSON.
					raw = `[]`
				}
				requests := make(chan []byte, 4)
				var round atomic.Int32
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						http.Error(w, "read request", http.StatusBadRequest)
						return
					}
					select {
					case requests <- body:
					default:
						http.Error(w, "unexpected retry loop", http.StatusBadRequest)
						return
					}
					var calls []recoveryCall
					text := ""
					switch round.Add(1) {
					case 1:
						calls = []recoveryCall{{"call_bad", raw}, {"call_good", `{"text":"good"}`}}
					case 2:
						calls = []recoveryCall{{"call_fixed", `{"text":"fixed"}`}}
					case 3:
						text = "done"
					default:
						http.Error(w, "unexpected model call", http.StatusBadRequest)
						return
					}
					contentType, payload := recoveryReply(protocol, stream, calls, text)
					w.Header().Set("Content-Type", contentType)
					_, _ = io.WriteString(w, payload)
				}))
				defer srv.Close()
				llm, err := provider.NewLLM(provider.Channel{
					APIProtocol: protocol, BaseURL: srv.URL, APIKey: "test",
					Models: []provider.ModelEntry{{Name: "fixture"}},
				}, &provider.Options{})
				if err != nil {
					t.Fatal(err)
				}
				executed := make(chan string, 4)
				// The tool accepts an empty object, so executing placeholder Args
				// would reach the callback and fail this test.
				probe, err := functiontool.New[map[string]any, map[string]any](functiontool.Config{Name: "probe"}, func(_ adkagent.Context, args map[string]any) (map[string]any, error) {
					text, _ := args["text"].(string)
					executed <- text
					return map[string]any{"text": text}, nil
				})
				if err != nil {
					t.Fatal(err)
				}
				cfg := config.Default()
				a, err := New(t.TempDir(), "recovery", &cfg, Options{Model: llm, Tools: []tool.Tool{probe}})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				created, err := a.Sessions.Create(ctx, &session.CreateRequest{AppName: a.App(), UserID: a.User(), SessionID: "recovery"})
				if err != nil {
					t.Fatal(err)
				}
				finished := false
				for ev, err := range a.Run(ctx, created.Session, genai.NewContentFromText("run probe", genai.RoleUser)) {
					if err != nil {
						t.Fatal(err)
					}
					if ev.IsFinalResponse() && plainText(ev.Content) == "done" {
						finished = true
					}
				}
				if !finished || round.Load() != 3 {
					t.Fatalf("model did not recover: finished=%v rounds=%d", finished, round.Load())
				}
				close(executed)
				var got []string
				for text := range executed {
					got = append(got, text)
				}
				if strings.Join(got, ",") != "good,fixed" {
					t.Fatalf("malformed input executed or valid input lost: %v", got)
				}
				<-requests // Initial user request.
				feedback := recoveryResults(t, protocol, <-requests)
				var failure struct {
					Error string `json:"error"`
				}
				if err := json.Unmarshal([]byte(feedback["call_bad"]), &failure); err != nil {
					t.Fatal(err)
				}
				if message := failure.Error; !strings.Contains(message, "arguments JSON") || !strings.Contains(message, raw) || !strings.Contains(message, "retry") {
					t.Fatalf("model did not receive actionable parse failure: %v", feedback)
				}
				if !strings.Contains(feedback["call_good"], "good") {
					t.Fatalf("valid call in the same batch did not complete: %v", feedback)
				}
				if results := recoveryResults(t, protocol, <-requests); !strings.Contains(results["call_fixed"], "fixed") {
					t.Fatalf("corrected call did not reach the model: %v", results)
				}
			})
		}
	}
}

type recoveryCall struct{ id, raw string }

func recoveryReply(protocol string, stream bool, calls []recoveryCall, text string) (string, string) {
	encode := func(v any) string {
		data, err := json.Marshal(v)
		if err != nil {
			panic(err)
		}
		return string(data)
	}
	sse := func(v any) string { return "data: " + encode(v) + "\n\n" }
	switch protocol {
	case provider.ProtocolChatCompletions:
		wireCalls := []any{}
		for i, call := range calls {
			wireCalls = append(wireCalls, map[string]any{"index": i, "id": call.id, "type": "function", "function": map[string]any{"name": "probe", "arguments": call.raw}})
		}
		message := map[string]any{"content": text, "tool_calls": wireCalls}
		if stream {
			return "text/event-stream", sse(map[string]any{"choices": []any{map[string]any{"delta": message}}}) + "data: [DONE]\n\n"
		}
		message["role"] = "assistant"
		return "application/json", encode(map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": "stop"}}})
	case provider.ProtocolResponses:
		output := []any{}
		for _, call := range calls {
			output = append(output, map[string]any{"type": "function_call", "call_id": call.id, "name": "probe", "arguments": call.raw})
		}
		if text != "" {
			output = append(output, map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": text}}})
		}
		response := map[string]any{"status": "completed", "output": output}
		if stream {
			return "text/event-stream", sse(map[string]any{"type": "response.completed", "response": response})
		}
		return "application/json", encode(response)
	default:
		if stream {
			var body strings.Builder
			for i, call := range calls {
				body.WriteString(sse(map[string]any{"type": "content_block_start", "index": i, "content_block": map[string]any{"type": "tool_use", "id": call.id, "name": "probe", "input": map[string]any{}}}))
				body.WriteString(sse(map[string]any{"type": "content_block_delta", "index": i, "delta": map[string]any{"type": "input_json_delta", "partial_json": call.raw}}))
			}
			if text != "" {
				body.WriteString(sse(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}}))
			}
			body.WriteString(sse(map[string]any{"type": "message_stop"}))
			return "text/event-stream", body.String()
		}
		content := []any{}
		for _, call := range calls {
			content = append(content, map[string]any{"type": "tool_use", "id": call.id, "name": "probe", "input": json.RawMessage(call.raw)})
		}
		if text != "" {
			content = append(content, map[string]any{"type": "text", "text": text})
		}
		return "application/json", encode(map[string]any{"role": "assistant", "content": content})
	}
}

func recoveryResults(t *testing.T, protocol string, raw []byte) map[string]string {
	t.Helper()
	var request struct {
		Messages []struct {
			Role       string          `json:"role"`
			ToolCallID string          `json:"tool_call_id"`
			Content    json.RawMessage `json:"content"`
		} `json:"messages"`
		Input []struct {
			Type   string `json:"type"`
			CallID string `json:"call_id"`
			Output string `json:"output"`
		} `json:"input"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	results := map[string]string{}
	for _, message := range request.Messages {
		if protocol == provider.ProtocolChatCompletions && message.Role == "tool" {
			var text string
			if err := json.Unmarshal(message.Content, &text); err != nil {
				t.Fatal(err)
			}
			results[message.ToolCallID] = text
		}
		if protocol == provider.ProtocolAnthropic && message.Role == "user" {
			var blocks []struct {
				Type    string `json:"type"`
				ID      string `json:"tool_use_id"`
				Content string `json:"content"`
			}
			if len(message.Content) > 0 && message.Content[0] == '[' {
				if err := json.Unmarshal(message.Content, &blocks); err != nil {
					t.Fatal(err)
				}
				for _, block := range blocks {
					if block.Type == "tool_result" {
						results[block.ID] = block.Content
					}
				}
			}
		}
	}
	for _, item := range request.Input {
		if item.Type == "function_call_output" {
			results[item.CallID] = item.Output
		}
	}
	return results
}

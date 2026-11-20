package provider

import (
	"net/http"
	"testing"

	"google.golang.org/genai"
)

func reply(protocol string) string {
	switch protocol {
	case ProtocolResponses:
		return `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{}}`
	case ProtocolAnthropic:
		return `{"role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}`
	default:
		return `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`
	}
}

// 配置了强度目录的模型按原文上行（含大小写与 max）；目录外取值
// 与显式空目录都不发送强度字段。
func TestConfiguredReasoningEffortWire(t *testing.T) {
	for _, tc := range []struct {
		name     string
		protocol string
		key      string
		effort   string
		want     string
	}{
		{"chat_completions_turbo", ProtocolChatCompletions, "reasoning_effort", "Turbo", "Turbo"},
		{"responses_turbo", ProtocolResponses, "reasoning", "Turbo", "Turbo"},
		{"responses_max", ProtocolResponses, "reasoning", "max", "max"},
		{"anthropic_turbo", ProtocolAnthropic, "output_config", "Turbo", "Turbo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(reply(tc.protocol)))
			})
			channel := testChannel(tc.protocol, srv.URL)
			channel.Models[0].ReasoningEfforts = []string{"Turbo", "max"}
			llm, err := NewLLM(channel, &Options{ReasoningEffort: tc.effort})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), false); err != nil {
				t.Fatal(err)
			}
			switch tc.key {
			case "reasoning_effort":
				if (*body)["reasoning_effort"] != tc.want {
					t.Fatalf("reasoning_effort = %v", (*body)["reasoning_effort"])
				}
			case "reasoning":
				if (*body)["reasoning"].(map[string]any)["effort"] != tc.want {
					t.Fatalf("reasoning = %v", (*body)["reasoning"])
				}
			case "output_config":
				if (*body)["output_config"].(map[string]any)["effort"] != tc.want {
					t.Fatalf("output_config = %v", (*body)["output_config"])
				}
			}
		})
	}
}

func TestConfiguredReasoningEffortOmitsField(t *testing.T) {
	for _, tc := range []struct {
		name   string
		levels []string
		effort string
	}{
		{"explicit_empty", []string{}, "high"},
		{"out_of_catalog", []string{"low"}, "Turbo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(reply(ProtocolChatCompletions)))
			})
			channel := testChannel(ProtocolChatCompletions, srv.URL)
			channel.Models[0].ReasoningEfforts = tc.levels
			llm, err := NewLLM(channel, &Options{ReasoningEffort: tc.effort})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), false); err != nil {
				t.Fatal(err)
			}
			if _, ok := (*body)["reasoning_effort"]; ok {
				t.Fatalf("reasoning_effort should be omitted: %v", (*body)["reasoning_effort"])
			}
		})
	}
}

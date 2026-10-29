package provider

import (
	"net/http"
	"strings"
	"testing"

	"google.golang.org/genai"
)

func TestAnthropicSync(t *testing.T) {
	srv, body, header := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"role":"assistant","content":[{"type":"thinking","thinking":"pondering"},{"type":"text","text":"bonjour"},{"type":"tool_use","id":"tu_1","name":"echo","input":{"text":"yo"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":3},"stop_reason":"tool_use"}`))
	})
	llm, err := NewLLM(testChannel(ProtocolAnthropic, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("salut")}, echoToolDecl()), false)
	if err != nil || len(out) != 1 {
		t.Fatalf("sync: %v len=%d", err, len(out))
	}
	final := out[0]
	p0, p1, p2 := final.Content.Parts[0], final.Content.Parts[1], final.Content.Parts[2]
	if p0.Text != "pondering" || !p0.Thought {
		t.Fatalf("thinking part = %+v", p0)
	}
	if p1.Text != "bonjour" {
		t.Fatalf("text part = %+v", p1)
	}
	if p2.FunctionCall.ID != "tu_1" || p2.FunctionCall.Args["text"] != "yo" {
		t.Fatalf("tool part = %+v", p2)
	}
	// prompt = input + cacheRead + cacheWrite = 15。
	if final.UsageMetadata.PromptTokenCount != 15 || final.UsageMetadata.CachedContentTokenCount != 2 {
		t.Fatalf("usage = %+v", final.UsageMetadata)
	}
	if final.CustomMetadata["cacheCreationTokens"] != int64(3) {
		t.Fatalf("custom metadata = %+v", final.CustomMetadata)
	}
	if header.Get("x-api-key") != "sk-test" || header.Get("anthropic-version") != "2023-06-01" {
		t.Fatalf("headers missing auth: %+v", header)
	}
	if (*body)["system"] != "be brief" {
		t.Fatalf("system = %v", (*body)["system"])
	}
	if (*body)["max_tokens"] != float64(1024) {
		t.Fatalf("max_tokens = %v", (*body)["max_tokens"])
	}
	tools := (*body)["tools"].([]any)
	fn := tools[0].(map[string]any)
	if fn["name"] != "echo" || fn["input_schema"].(map[string]any)["type"] != "object" {
		t.Fatalf("tool = %+v", fn)
	}
}

func TestAnthropicToolAndThinkingReplay(t *testing.T) {
	srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"output_tokens":1}}`))
	})
	llm, err := NewLLM(testChannel(ProtocolAnthropic, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	contents := []*genai.Content{
		userContent("go"),
		{Role: genai.RoleModel, Parts: []*genai.Part{
			{Text: "hmm", Thought: true},
			{FunctionCall: &genai.FunctionCall{ID: "tu_1", Name: "echo", Args: map[string]any{"text": "hi"}}},
		}},
		{Role: genai.RoleUser, Parts: []*genai.Part{
			{FunctionResponse: &genai.FunctionResponse{ID: "tu_1", Name: "echo", Response: map[string]any{"result": "hi"}}},
		}},
		{Role: genai.RoleUser, Parts: []*genai.Part{
			{FunctionResponse: &genai.FunctionResponse{ID: "tu_2", Name: "other", Response: map[string]any{"ok": true}}},
		}},
	}
	if _, err := collectLLM(llm, reqWith(contents), false); err != nil {
		t.Fatal(err)
	}
	msgs := (*body)["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages = %d", len(msgs))
	}
	assistant := msgs[1].(map[string]any)
	blocks := assistant["content"].([]any)
	if blocks[0].(map[string]any)["type"] != "thinking" {
		t.Fatalf("first assistant block = %+v", blocks[0])
	}
	if blocks[1].(map[string]any)["type"] != "tool_use" || blocks[1].(map[string]any)["id"] != "tu_1" {
		t.Fatalf("tool_use block = %+v", blocks[1])
	}
	// 两条工具结果合并为一个用户轮次。
	toolTurn := msgs[2].(map[string]any)
	toolBlocks := toolTurn["content"].([]any)
	if toolTurn["role"] != "user" || len(toolBlocks) != 2 {
		t.Fatalf("tool results not merged: %+v", toolTurn)
	}
	if toolBlocks[0].(map[string]any)["tool_use_id"] != "tu_1" {
		t.Fatalf("tool_result = %+v", toolBlocks[0])
	}
}

func TestAnthropicStream(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{
			`event: message_start` + "\n" + `data: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":0}}}`,
			`event: content_block_start` + "\n" + `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sal"}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ut"}}`,
			`event: content_block_stop` + "\n" + `data: {"type":"content_block_stop","index":0}`,
			`event: content_block_start` + "\n" + `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_7","name":"echo","input":{}}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"text\":"}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"go\"}"}}`,
			`event: content_block_stop` + "\n" + `data: {"type":"content_block_stop","index":1}`,
			`event: message_delta` + "\n" + `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}`,
			`event: message_stop` + "\n" + `data: {"type":"message_stop"}`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
		}
	})
	llm, err := NewLLM(testChannel(ProtocolAnthropic, srv.URL), &Options{})
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
	if out[0].Content.Parts[0].Text != "sal" || out[1].Content.Parts[0].Text != "ut" {
		t.Fatalf("partials wrong")
	}
	final := out[2]
	if final.Content.Parts[0].Text != "salut" {
		t.Fatalf("final text = %+v", final.Content.Parts[0])
	}
	fc := final.Content.Parts[1].FunctionCall
	if fc.ID != "tu_7" || fc.Args["text"] != "go" {
		t.Fatalf("final call = %+v", fc)
	}
	// prompt = 8 + 2 + 0 = 10，completion 被覆盖为 6。
	if final.UsageMetadata.PromptTokenCount != 10 || final.UsageMetadata.CandidatesTokenCount != 6 {
		t.Fatalf("usage = %+v", final.UsageMetadata)
	}
}

func TestAnthropicStreamError(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: error\n" + `data: {"type":"error","error":{"message":"overloaded"}}` + "\n\n"))
	})
	llm, err := NewLLM(testChannel(ProtocolAnthropic, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), true)
	if err == nil || !strings.Contains(err.Error(), "overloaded") {
		t.Fatalf("expected overloaded error, got %v", err)
	}
}

func TestEndpointDerivation(t *testing.T) {
	cases := []struct {
		protocol, base, want string
	}{
		{ProtocolChatCompletions, "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"},
		{ProtocolChatCompletions, "https://x.example/v1/chat/completions", "https://x.example/v1/chat/completions"},
		{ProtocolResponses, "https://api.openai.com/v1", "https://api.openai.com/v1/responses"},
		{ProtocolAnthropic, "https://api.anthropic.com", "https://api.anthropic.com/v1/messages"},
		{ProtocolAnthropic, "https://gw.example/anthropic/v1", "https://gw.example/anthropic/v1/messages"},
	}
	for _, c := range cases {
		got, err := deriveEndpoint(c.protocol, c.base)
		if err != nil || got != c.want {
			t.Fatalf("deriveEndpoint(%s, %s) = %q, %v; want %q", c.protocol, c.base, got, err, c.want)
		}
	}
	if _, err := deriveEndpoint(ProtocolChatCompletions, "ftp://bad"); err == nil {
		t.Fatal("expected error for non-http base")
	}
}

func TestChannelDefaultsAndFallback(t *testing.T) {
	ch := Channel{ID: "c", BaseURL: "https://x.example/v1", APIKey: "k", Models: []ModelEntry{{Name: "first"}}}
	if _, err := NewLLM(ch, &Options{}); err != nil {
		t.Fatalf("empty protocol should default to chat_completions: %v", err)
	}
	entry, ok := ch.Entry("missing")
	if !ok || entry.Name != "first" {
		t.Fatalf("entry fallback failed: %+v", entry)
	}
	bad := Channel{ID: "c", APIProtocol: "grpc"}
	if _, err := NewLLM(bad, &Options{}); err == nil {
		t.Fatal("expected unsupported protocol error")
	}
	empty := Channel{ID: "c", APIProtocol: ProtocolChatCompletions}
	if _, err := NewLLM(empty, &Options{}); err == nil {
		t.Fatal("expected no-models error")
	}
}

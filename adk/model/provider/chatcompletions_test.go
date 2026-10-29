package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

func testChannel(protocol, baseURL string) Channel {
	return Channel{
		ID: "test", Name: "Test", BaseURL: baseURL, APIKey: "sk-test",
		APIProtocol: protocol,
		Models:      []ModelEntry{{Name: "test-model", MaxTokens: 1024}},
	}
}

func collectLLM(llm model.LLM, req *model.LLMRequest, stream bool) ([]*model.LLMResponse, error) {
	var out []*model.LLMResponse
	for resp, err := range llm.GenerateContent(context.Background(), req, stream) {
		if err != nil {
			return out, err
		}
		out = append(out, resp)
	}
	return out, nil
}

func userContent(text string) *genai.Content {
	return genai.NewContentFromText(text, genai.RoleUser)
}

func reqWith(contents []*genai.Content, tools ...*genai.FunctionDeclaration) *model.LLMRequest {
	req := &model.LLMRequest{Model: "test-model", Contents: contents}
	if len(tools) > 0 {
		req.Config = &genai.GenerateContentConfig{
			SystemInstruction: genai.NewContentFromText("be brief", "system"),
			Tools:             []*genai.Tool{{FunctionDeclarations: tools}},
		}
	}
	return req
}

func echoToolDecl() *genai.FunctionDeclaration {
	return &genai.FunctionDeclaration{
		Name:        "echo",
		Description: "echo the input",
		Parameters: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"text": {Type: genai.TypeString, Description: "text to echo"},
			},
			Required: []string{"text"},
		},
	}
}

// captureRequest 返回一个服务端，它记录所处理的那一次请求的
// 解码后 JSON 请求体与请求头，并以 write(payload) 回复。
func captureRequest(t *testing.T, payload func(w http.ResponseWriter)) (*httptest.Server, *map[string]any, *http.Header) {
	t.Helper()
	var body map[string]any
	var header http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Clone()
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		payload(w)
	}))
	t.Cleanup(srv.Close)
	return srv, &body, &header
}

func TestChatCompletionsSync(t *testing.T) {
	srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"hello","tool_calls":[{"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"text\":\"hi\"}"}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}`))
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, echoToolDecl()), false)
	if err != nil || len(out) != 1 {
		t.Fatalf("sync call: %v, len=%d", err, len(out))
	}
	final := out[0]
	if !final.TurnComplete || final.Partial {
		t.Fatalf("expected final non-partial response")
	}
	if len(final.Content.Parts) != 2 {
		t.Fatalf("expected text+call parts, got %d", len(final.Content.Parts))
	}
	if final.Content.Parts[0].Text != "hello" {
		t.Fatalf("text = %q", final.Content.Parts[0].Text)
	}
	fc := final.Content.Parts[1].FunctionCall
	if fc.ID != "call_1" || fc.Name != "echo" || fc.Args["text"] != "hi" {
		t.Fatalf("function call = %+v", fc)
	}
	if final.UsageMetadata.PromptTokenCount != 10 || final.UsageMetadata.CachedContentTokenCount != 3 {
		t.Fatalf("usage = %+v", final.UsageMetadata)
	}
	// 请求体断言。
	if (*body)["model"] != "test-model" {
		t.Fatalf("model = %v", (*body)["model"])
	}
	msgs := (*body)["messages"].([]any)
	if msgs[0].(map[string]any)["role"] != "system" {
		t.Fatalf("first message should be system, got %+v", msgs[0])
	}
	tools := (*body)["tools"].([]any)
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "echo" {
		t.Fatalf("tool name = %v", fn["name"])
	}
	params := fn["parameters"].(map[string]any)
	if params["type"] != "object" {
		t.Fatalf("params type = %v", params["type"])
	}
	if (*body)["max_tokens"] != float64(1024) {
		t.Fatalf("max_tokens = %v", (*body)["max_tokens"])
	}
}

// TestChatCompletionsStreamReasoningField 覆盖把思考放在 reasoning 字段的
// 网关（OpenRouter 风格）；只认 reasoning_content 会丢掉整段思考。
func TestChatCompletionsStreamReasoningField(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, f := range []string{
			`data: {"choices":[{"delta":{"reasoning":"想"}}]}`,
			`data: {"choices":[{"delta":{"reasoning":"一想"}}]}`,
			`data: {"choices":[{"delta":{"content":"答案"}}]}`,
			`data: [DONE]`,
		} {
			_, _ = w.Write([]byte(f + "\n\n"))
		}
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 4 { // 2 个推理增量 + 1 个正文增量 + 1 个最终响应
		t.Fatalf("events = %d", len(out))
	}
	for i, want := range []string{"想", "一想"} {
		part := out[i].Content.Parts[0]
		if !out[i].Partial || !part.Thought || part.Text != want {
			t.Fatalf("partial %d = %+v", i, out[i])
		}
	}
	if got := out[2].Content.Parts[0]; got.Thought || got.Text != "答案" {
		t.Fatalf("content partial = %+v", got)
	}
	if got := out[3].Content.Parts[0]; got.Text != "想一想" || !got.Thought {
		t.Fatalf("final reasoning = %+v", got)
	}
}

// TestChatCompletionsSyncReasoningField 覆盖非流式响应使用 reasoning
// 字段的网关。
func TestChatCompletionsSyncReasoningField(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"答案","reasoning":"先想一下"},"finish_reason":"stop"}]}`))
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("events = %d", len(out))
	}
	if got := out[0].Content.Parts[0]; got.Text != "先想一下" || !got.Thought {
		t.Fatalf("reasoning = %+v", got)
	}
}

func TestChatCompletionsStream(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{
			`data: {"choices":[{"delta":{"reasoning_content":"think-"}}]}`,
			`data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}`,
			`data: {"choices":[{"delta":{"content":"hel"}}]}`,
			`data: {"choices":[{"delta":{"content":"lo"}}]}`,
			`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"echo"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"te"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"xt\":\"yo\"}"}}]}}]}`,
			`data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}`,
			`data: [DONE]`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
		}
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, echoToolDecl()), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 5 { // 2 个推理 + 2 个文本部分事件 + 1 个最终响应
		t.Fatalf("events = %d", len(out))
	}
	for i, want := range []string{"think-", "hard", "hel", "lo"} {
		p := out[i]
		if !p.Partial || p.Content.Parts[0].Text != want {
			t.Fatalf("partial %d = %+v", i, p)
		}
	}
	for i := 0; i < 2; i++ {
		if !out[i].Content.Parts[0].Thought {
			t.Fatalf("reasoning partial %d should be Thought", i)
		}
	}
	final := out[len(out)-1]
	if final.Partial || !final.TurnComplete {
		t.Fatalf("final flags wrong: %+v", final)
	}
	if got := final.Content.Parts[0]; got.Text != "think-hard" || !got.Thought {
		t.Fatalf("final reasoning = %+v", got)
	}
	if final.Content.Parts[1].Text != "hello" {
		t.Fatalf("final text = %+v", final.Content.Parts[1])
	}
	fc := final.Content.Parts[2].FunctionCall
	if fc.ID != "call_9" || fc.Args["text"] != "yo" {
		t.Fatalf("final call = %+v", fc)
	}
	if final.UsageMetadata.PromptTokenCount != 7 {
		t.Fatalf("usage = %+v", final.UsageMetadata)
	}
}

func TestChatCompletionsToolRoundTrip(t *testing.T) {
	srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{}}`))
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	contents := []*genai.Content{
		userContent("run echo"),
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
	msgs := (*body)["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages = %d", len(msgs))
	}
	assistant := msgs[1].(map[string]any)
	calls := assistant["tool_calls"].([]any)
	call := calls[0].(map[string]any)
	if call["id"] != "call_1" || call["function"].(map[string]any)["name"] != "echo" {
		t.Fatalf("assistant call = %+v", call)
	}
	toolMsg := msgs[2].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_1" || toolMsg["content"] != "hi" {
		t.Fatalf("tool message = %+v", toolMsg)
	}
}

func TestChatCompletionsOpenCodeHeader(t *testing.T) {
	srv, _, header := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{}}`))
	})
	ch := testChannel(ProtocolChatCompletions, srv.URL)
	ch.SpecialCompatibility = SpecialOpenCode
	llm, err := NewLLM(ch, &Options{SessionKey: "sess-42"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), false); err != nil {
		t.Fatal(err)
	}
	if got := header.Get("x-opencode-session"); got != "sess-42" {
		t.Fatalf("x-opencode-session = %q, want sess-42", got)
	}
	// 热切换该键，并验证下一次调用使用新值。
	s := NewSettings("", "sess-99", false, 0)
	_ = s
	if holder, ok := llm.(*chatAdapter); ok {
		holder.config.Settings.Update("high", "sess-99", false, 0)
		if _, err := collectLLM(holder, reqWith([]*genai.Content{userContent("hi")}), false); err != nil {
			t.Fatal(err)
		}
		if got := header.Get("x-opencode-session"); got != "sess-99" {
			t.Fatalf("x-opencode-session after swap = %q, want sess-99", got)
		}
	}
}

func TestChatErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
	}))
	defer srv.Close()
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}), false)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("expected HTTP 401 error, got %v", err)
	}
}

// rgLikeArgs 用来复现 functiontool 生成的参数声明形态。
type rgLikeArgs struct {
	Pattern    string   `json:"pattern,omitempty" jsonschema:"内容正则"`
	Mode       string   `json:"mode,omitempty" jsonschema:"content 或 files"`
	Globs      []string `json:"globs,omitempty" jsonschema:"文件过滤"`
	MaxResults int      `json:"max_results,omitempty" jsonschema:"最多输出行数"`
}

// TestChatCompletionsSendsParameterSchema 覆盖参数 JSON Schema 的下发：
// functiontool 只填 ParametersJsonSchema，且其动态类型是 *jsonschema.Schema，
// 早先的实现按 map[string]any 断言会失败，导致参数说明整个丢失。
func TestChatCompletionsSendsParameterSchema(t *testing.T) {
	srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`))
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	schema, err := jsonschema.For[rgLikeArgs](nil)
	if err != nil {
		t.Fatal(err)
	}
	decl := &genai.FunctionDeclaration{
		Name:                 "rg",
		Description:          "search",
		ParametersJsonSchema: schema,
	}
	if _, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, decl), false); err != nil {
		t.Fatal(err)
	}
	tools := (*body)["tools"].([]any)
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	params, ok := fn["parameters"].(map[string]any)
	if !ok {
		t.Fatalf("parameters 未下发到模型: %+v", fn)
	}
	props, ok := params["properties"].(map[string]any)
	if !ok {
		t.Fatalf("parameters.properties 缺失: %+v", params)
	}
	for _, name := range []string{"pattern", "mode", "globs", "max_results"} {
		if _, ok := props[name]; !ok {
			t.Fatalf("parameters 缺少 %q: %+v", name, props)
		}
	}
}

// TestChatCompletionsStreamParallelToolCalls 覆盖同一条消息里的多个
// tool_call 分片：它们必须保持独立，参数不能被拼接到一起。
func TestChatCompletionsStreamParallelToolCalls(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_rg","type":"function","function":{"name":"rg","arguments":""}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_sh","type":"function","function":{"name":"powershell","arguments":""}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"mode\":\"files\"}"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"command\":\"Get-ChildItem\"}"}}]}}]}`,
			`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			`data: [DONE]`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
		}
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, echoToolDecl()), true)
	if err != nil {
		t.Fatal(err)
	}
	final := out[len(out)-1]
	calls := map[string]*genai.FunctionCall{}
	for _, p := range final.Content.Parts {
		if p.FunctionCall != nil {
			calls[p.FunctionCall.Name] = p.FunctionCall
		}
	}
	if len(calls) != 2 {
		t.Fatalf("期望两个独立调用，实际 %d: %+v", len(calls), final.Content.Parts)
	}
	if fc := calls["rg"]; fc == nil || fc.ID != "call_rg" || fc.Args["mode"] != "files" {
		t.Fatalf("rg 调用 = %+v", calls["rg"])
	}
	if fc := calls["powershell"]; fc == nil || fc.ID != "call_sh" || fc.Args["command"] != "Get-ChildItem" {
		t.Fatalf("powershell 调用 = %+v", calls["powershell"])
	}
}

// TestChatCompletionsStreamToolCallsWithoutIndex 覆盖不发送 index 的网关：
// 所有分片都落在 index 0，只能靠新出现的调用 id 拆分。
func TestChatCompletionsStreamToolCallsWithoutIndex(t *testing.T) {
	srv, _, _ := captureRequest(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		frames := []string{
			`data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"rg"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\"mode\":\"files\"}"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","type":"function","function":{"name":"powershell"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\"command\":\"ls\"}"}}]}}]}`,
			`data: [DONE]`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
		}
	})
	llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := collectLLM(llm, reqWith([]*genai.Content{userContent("hi")}, echoToolDecl()), true)
	if err != nil {
		t.Fatal(err)
	}
	final := out[len(out)-1]
	calls := map[string]*genai.FunctionCall{}
	for _, p := range final.Content.Parts {
		if p.FunctionCall != nil {
			calls[p.FunctionCall.Name] = p.FunctionCall
		}
	}
	if len(calls) != 2 {
		t.Fatalf("期望两个独立调用，实际 %d: %+v", len(calls), final.Content.Parts)
	}
	if fc := calls["rg"]; fc == nil || fc.ID != "call_a" || fc.Args["mode"] != "files" {
		t.Fatalf("rg 调用 = %+v", calls["rg"])
	}
	if fc := calls["powershell"]; fc == nil || fc.ID != "call_b" || fc.Args["command"] != "ls" {
		t.Fatalf("powershell 调用 = %+v", calls["powershell"])
	}
}

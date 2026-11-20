package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sync"
	"testing"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

// replayServer 记录每一次请求体，并按到达顺序调用 respond 应答。
func replayServer(t *testing.T, respond func(call int, w http.ResponseWriter)) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var bodies []map[string]any
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		mu.Lock()
		bodies = append(bodies, body)
		call := len(bodies) - 1
		mu.Unlock()
		respond(call, w)
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

// redirectTransport 把请求改道到测试服务器，使以真实域名推导
// Endpoint 的通道（如 openrouter.ai）也能走 httptest。
type redirectTransport struct{ target string }

func (t *redirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u, err := url.Parse(t.target)
	if err != nil {
		return nil, err
	}
	clone := req.Clone(req.Context())
	clone.URL.Scheme = u.Scheme
	clone.URL.Host = u.Host
	clone.Host = u.Host
	return http.DefaultTransport.RoundTrip(clone)
}

// deepseekChannel 用模型名前缀命中 reasoning_content 续接字段；
// httptest 的主机名不参与判定。
func deepseekChannel(baseURL string) Channel {
	return Channel{
		ID: "deepseek", Name: "DeepSeek", BaseURL: baseURL, APIKey: "sk-ds",
		APIProtocol: ProtocolChatCompletions,
		Models:      []ModelEntry{{Name: "deepseek-reasoner", MaxTokens: 1024}},
	}
}

// replayToolReq 构造带 echo 工具声明的请求，模型名显式指定以
// 覆盖渠道默认模型。
func replayToolReq(modelName string, contents ...*genai.Content) *model.LLMRequest {
	return &model.LLMRequest{
		Model:    modelName,
		Contents: contents,
		Config: &genai.GenerateContentConfig{
			SystemInstruction: genai.NewContentFromText("be brief", "system"),
			Tools:             []*genai.Tool{{FunctionDeclarations: []*genai.FunctionDeclaration{echoToolDecl()}}},
		},
	}
}

// finalContent 收集一次调用并返回最终响应的内容。
func finalContent(t *testing.T, llm model.LLM, req *model.LLMRequest, stream bool) *genai.Content {
	t.Helper()
	out, err := collectLLM(llm, req, stream)
	if err != nil {
		t.Fatalf("GenerateContent: %v", err)
	}
	if len(out) == 0 || out[len(out)-1].Content == nil {
		t.Fatalf("no final content in %d responses", len(out))
	}
	return out[len(out)-1].Content
}

// continuation 把首轮模型内容与对应的工具结果拼成续接历史。
func continuation(model *genai.Content, callID, result string) []*genai.Content {
	return []*genai.Content{
		userContent("run echo"),
		model,
		{Role: genai.RoleUser, Parts: []*genai.Part{{
			FunctionResponse: &genai.FunctionResponse{ID: callID, Name: "echo", Response: map[string]any{"result": result}},
		}}},
	}
}

func chatReply(w http.ResponseWriter, payload string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, payload)
}

func TestChatReasoningReplay(t *testing.T) {
	t.Run("deepseek sync replays reasoning_content", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"  先想\n清楚  ","tool_calls":[{"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"text\":\"hi\"}"}}]},"finish_reason":"tool_calls"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("deepseek-reasoner", userContent("run echo")), false)
		thought := first.Parts[0]
		if !thought.Thought || thought.Text != "  先想\n清楚  " {
			t.Fatalf("thought = %+v", thought)
		}
		if thought.PartMetadata[ReasoningReplayMetadataKey] == nil {
			t.Fatal("thought part is not marked for replay")
		}
		finalContent(t, llm, replayToolReq("deepseek-reasoner", continuation(first, "call_1", "hi")...), false)
		msgs := (*bodies)[1]["messages"].([]any)
		assistant := msgs[2].(map[string]any)
		if assistant["reasoning_content"] != "  先想\n清楚  " {
			t.Fatalf("reasoning_content = %v, want exact whitespace", assistant["reasoning_content"])
		}
		call := assistant["tool_calls"].([]any)[0].(map[string]any)
		if call["id"] != "call_1" {
			t.Fatalf("assistant call = %+v", call)
		}
		toolMsg := msgs[3].(map[string]any)
		if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_1" || toolMsg["content"] != "hi" {
			t.Fatalf("tool message = %+v", toolMsg)
		}
	})

	t.Run("deepseek stream replays reasoning_content", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				w.Header().Set("Content-Type", "text/event-stream")
				for _, f := range []string{
					`data: {"choices":[{"delta":{"reasoning_content":"think-"}}]}`,
					`data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}`,
					`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"echo","arguments":"{\"text\":\"x\"}"}}]}}]}`,
					`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
					`data: [DONE]`,
				} {
					fmt.Fprint(w, f+"\n\n")
				}
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("deepseek-reasoner", userContent("run")), true)
		if first.Parts[0].PartMetadata[ReasoningReplayMetadataKey] == nil {
			t.Fatal("stream thought is not marked for replay")
		}
		finalContent(t, llm, replayToolReq("deepseek-reasoner", continuation(first, "call_7", "x")...), false)
		assistant := (*bodies)[1]["messages"].([]any)[2].(map[string]any)
		if assistant["reasoning_content"] != "think-hard" {
			t.Fatalf("reasoning_content = %v", assistant["reasoning_content"])
		}
	})

	t.Run("openrouter replays reasoning field", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning":"想明白","tool_calls":[{"id":"call_2","type":"function","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		ch := Channel{
			ID: "or", Name: "OpenRouter", BaseURL: "https://openrouter.ai/api/v1", APIKey: "sk-or",
			APIProtocol: ProtocolChatCompletions,
			Models:      []ModelEntry{{Name: "some-model", MaxTokens: 1024}},
		}
		llm, err := NewLLM(ch, &Options{Client: &http.Client{Transport: &redirectTransport{target: srv.URL}}})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("some-model", userContent("run")), false)
		finalContent(t, llm, replayToolReq("some-model", continuation(first, "call_2", "x")...), false)
		assistant := (*bodies)[1]["messages"].([]any)[2].(map[string]any)
		if assistant["reasoning"] != "想明白" {
			t.Fatalf("reasoning = %v", assistant)
		}
		if _, ok := assistant["reasoning_content"]; ok {
			t.Fatalf("openrouter replay must use reasoning, not reasoning_content: %v", assistant)
		}
	})

	t.Run("deepseek thought-only message is preserved", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"沉默的想法"},"finish_reason":"stop"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("deepseek-reasoner", userContent("think")), false)
		finalContent(t, llm, replayToolReq("deepseek-reasoner",
			userContent("think"), first, userContent("next")), false)
		msgs := (*bodies)[1]["messages"].([]any)
		assistant := msgs[2].(map[string]any)
		if assistant["role"] != "assistant" || assistant["content"] != "" || assistant["reasoning_content"] != "沉默的想法" {
			t.Fatalf("thought-only assistant message = %+v", assistant)
		}
	})

	t.Run("openrouter thought-only message is skipped", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		ch := Channel{
			ID: "or", Name: "OpenRouter", BaseURL: "https://openrouter.ai/api/v1", APIKey: "sk-or",
			APIProtocol: ProtocolChatCompletions,
			Models:      []ModelEntry{{Name: "some-model", MaxTokens: 1024}},
		}
		llm, err := NewLLM(ch, &Options{Client: &http.Client{Transport: &redirectTransport{target: srv.URL}}})
		if err != nil {
			t.Fatal(err)
		}
		adapter := llm.(*chatAdapter)
		thought := &genai.Part{Text: "安静", Thought: true}
		setReasoningReplay(thought, adapter.config.reasoningReplayScope("some-model"), "field", "reasoning")
		modelContent := &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{thought}}
		finalContent(t, llm, replayToolReq("some-model",
			userContent("a"), modelContent, userContent("b")), false)
		for _, raw := range (*bodies)[0]["messages"].([]any) {
			msg := raw.(map[string]any)
			if _, ok := msg["reasoning"]; ok {
				t.Fatalf("thought-only openrouter message should be skipped: %v", msg)
			}
		}
	})

	t.Run("unmarked legacy thought is not replayed", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		modelContent := &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{
			{Text: "旧思考", Thought: true},
			{Text: "答案"},
		}}
		finalContent(t, llm, replayToolReq("deepseek-reasoner",
			userContent("q"), modelContent, userContent("next")), false)
		assistant := (*bodies)[0]["messages"].([]any)[2].(map[string]any)
		if assistant["content"] != "答案" {
			t.Fatalf("content = %v", assistant["content"])
		}
		if _, ok := assistant["reasoning_content"]; ok {
			t.Fatalf("unmarked thought must not replay: %v", assistant)
		}
	})

	t.Run("model or channel switch does not replay", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"绑定原渠道","tool_calls":[{"id":"call_5","type":"function","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("deepseek-reasoner", userContent("run")), false)
		// 换模型：同一适配器、不同请求模型，作用域失配。
		finalContent(t, llm, replayToolReq("other-model", continuation(first, "call_5", "x")...), false)
		assistant := (*bodies)[1]["messages"].([]any)[2].(map[string]any)
		if _, ok := assistant["reasoning_content"]; ok {
			t.Fatalf("model switch must not replay: %v", assistant)
		}
		// 换渠道：另一把密钥的适配器也不回放同一批历史。
		other := deepseekChannel(srv.URL)
		other.APIKey = "sk-other"
		llm2, err := NewLLM(other, &Options{})
		if err != nil {
			t.Fatal(err)
		}
		finalContent(t, llm2, replayToolReq("deepseek-reasoner", continuation(first, "call_5", "x")...), false)
		assistant = (*bodies)[2]["messages"].([]any)[2].(map[string]any)
		if _, ok := assistant["reasoning_content"]; ok {
			t.Fatalf("channel switch must not replay: %v", assistant)
		}
	})

	t.Run("unknown destination keeps old shape", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"想一下","content":"好"},"finish_reason":"stop"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("test-model", userContent("hi")), false)
		if len(first.Parts[0].PartMetadata) != 0 {
			t.Fatalf("unknown destination must not mark replay state: %v", first.Parts[0].PartMetadata)
		}
		finalContent(t, llm, replayToolReq("test-model", userContent("hi"), first, userContent("next")), false)
		assistant := (*bodies)[1]["messages"].([]any)[2].(map[string]any)
		if _, ok := assistant["reasoning_content"]; ok {
			t.Fatalf("unknown destination must not replay: %v", assistant)
		}
	})

	t.Run("effort none skips replay", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"别回放","tool_calls":[{"id":"call_6","type":"function","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{ReasoningEffort: "none"})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("deepseek-reasoner", userContent("run")), false)
		finalContent(t, llm, replayToolReq("deepseek-reasoner", continuation(first, "call_6", "x")...), false)
		body := (*bodies)[1]
		if body["reasoning_effort"] != "none" {
			t.Fatalf("reasoning_effort = %v", body["reasoning_effort"])
		}
		assistant := body["messages"].([]any)[2].(map[string]any)
		if _, ok := assistant["reasoning_content"]; ok {
			t.Fatalf("effort none must not replay: %v", assistant)
		}
	})

	t.Run("deepseek text and thought without tool still replays", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				chatReply(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"先想","content":"答案"},"finish_reason":"stop"}],"usage":{}}`)
				return
			}
			chatReply(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{}}`)
		})
		llm, err := NewLLM(deepseekChannel(srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("deepseek-reasoner", userContent("ask")), false)
		finalContent(t, llm, replayToolReq("deepseek-reasoner",
			userContent("ask"), first, userContent("next")), false)
		assistant := (*bodies)[1]["messages"].([]any)[2].(map[string]any)
		if assistant["content"] != "答案" || assistant["reasoning_content"] != "先想" {
			t.Fatalf("assistant = %+v", assistant)
		}
	})
}

func responsesReply(w http.ResponseWriter, payload string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, payload)
}

func TestResponsesReasoningReplay(t *testing.T) {
	t.Run("sync replays encrypted reasoning and phase", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				responsesReply(w, `{"status":"completed","output":[
					{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"盘算"}],"encrypted_content":"enc-blob-1"},
					{"id":"msg_1","type":"message","phase":"final_answer","content":[{"type":"output_text","text":"好"}]},
					{"id":"fc_1","type":"function_call","call_id":"call_9","name":"echo","arguments":"{\"text\":\"yo\"}"}
				],"usage":{}}`)
				return
			}
			responsesReply(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{}}`)
		})
		llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("test-model", userContent("run")), false)
		body := (*bodies)[0]
		if store, ok := body["store"].(bool); !ok || store {
			t.Fatalf("store = %v, want false", body["store"])
		}
		include, _ := body["include"].([]any)
		if len(include) != 1 || include[0] != "reasoning.encrypted_content" {
			t.Fatalf("include = %v", body["include"])
		}
		if _, ok := body["previous_response_id"]; ok {
			t.Fatal("replay must not use previous_response_id")
		}
		if len(first.Parts) != 3 {
			t.Fatalf("parts = %d, want thought+text+call", len(first.Parts))
		}
		if !first.Parts[0].Thought || first.Parts[0].Text != "盘算" {
			t.Fatalf("thought = %+v", first.Parts[0])
		}
		finalContent(t, llm, replayToolReq("test-model", continuation(first, "call_9", "yo")...), false)
		input := (*bodies)[1]["input"].([]any)
		if len(input) != 5 {
			t.Fatalf("input items = %d, want 5: %v", len(input), input)
		}
		reasoning := input[1].(map[string]any)
		if reasoning["type"] != "reasoning" || reasoning["id"] != "rs_1" || reasoning["encrypted_content"] != "enc-blob-1" {
			t.Fatalf("reasoning item = %+v", reasoning)
		}
		summary := reasoning["summary"].([]any)
		if summary[0].(map[string]any)["text"] != "盘算" {
			t.Fatalf("reasoning summary lost in raw replay: %v", reasoning)
		}
		msg := input[2].(map[string]any)
		if msg["type"] != "message" || msg["role"] != "assistant" || msg["phase"] != "final_answer" {
			t.Fatalf("message item = %+v", msg)
		}
		call := input[3].(map[string]any)
		if call["type"] != "function_call" || call["call_id"] != "call_9" {
			t.Fatalf("function_call = %+v", call)
		}
		out := input[4].(map[string]any)
		if out["type"] != "function_call_output" || out["call_id"] != "call_9" || out["output"] != "yo" {
			t.Fatalf("function_call_output = %+v", out)
		}
	})

	t.Run("sync replays plaintext but not summary-only reasoning", func(t *testing.T) {
		const plain = `{"id":"rs_clear","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"  first\n"},{"type":"reasoning_text","text":"second  "}],"status":"completed"}`
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				responsesReply(w, `{"status":"completed","output":[`+plain+`,
					{"id":"rs_summary","type":"reasoning","summary":[{"type":"summary_text","text":"summary only"}]},
					{"type":"function_call","call_id":"call_plain","name":"echo","arguments":"{}"}
				]}`)
				return
			}
			responsesReply(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}`)
		})
		llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("test-model", userContent("run")), false)
		if len(first.Parts) != 3 || !first.Parts[0].Thought || first.Parts[0].Text != "  first\nsecond  " || !first.Parts[1].Thought || first.Parts[1].Text != "summary only" {
			t.Fatalf("unexpected displayed reasoning: %+v", first.Parts)
		}
		finalContent(t, llm, replayToolReq("test-model", continuation(first, "call_plain", "x")...), false)
		input := (*bodies)[1]["input"].([]any)
		var want map[string]any
		if err := json.Unmarshal([]byte(plain), &want); err != nil {
			t.Fatal(err)
		}
		if len(input) != 4 || !reflect.DeepEqual(input[1], want) || input[2].(map[string]any)["type"] != "function_call" || input[3].(map[string]any)["type"] != "function_call_output" {
			t.Fatalf("expected exact plaintext item before call and output, without summary-only item: %v", input)
		}
	})

	t.Run("opaque only reasoning has no text but still replays", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				responsesReply(w, `{"status":"completed","output":[
					{"id":"rs_2","type":"reasoning","summary":[],"encrypted_content":"enc-opaque"},
					{"type":"function_call","call_id":"call_3","name":"echo","arguments":"{}"}
				],"usage":{}}`)
				return
			}
			responsesReply(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{}}`)
		})
		llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("test-model", userContent("run")), false)
		thought := first.Parts[0]
		if !thought.Thought || thought.Text != "" {
			t.Fatalf("opaque reasoning must not synthesize text: %+v", thought)
		}
		finalContent(t, llm, replayToolReq("test-model", continuation(first, "call_3", "x")...), false)
		input := (*bodies)[1]["input"].([]any)
		reasoning := input[1].(map[string]any)
		if reasoning["type"] != "reasoning" || reasoning["encrypted_content"] != "enc-opaque" {
			t.Fatalf("reasoning item = %+v", reasoning)
		}
	})

	t.Run("stream done fallback prefers encrypted item", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			if call == 0 {
				w.Header().Set("Content-Type", "text/event-stream")
				for _, f := range []string{
					`event: response.output_item.done` + "\n" + `data: {"type":"response.output_item.done","item":{"id":"rs_9","type":"reasoning","summary":[{"type":"summary_text","text":"done里想"}],"encrypted_content":"enc-9"}}`,
					`event: response.completed` + "\n" + `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2},"output":[{"id":"rs_9","type":"reasoning","content":[{"type":"reasoning_text","text":"done里想"}],"summary":[]},{"type":"message","content":[{"type":"output_text","text":"好"}]}]}}`,
				} {
					fmt.Fprint(w, f+"\n\n")
				}
				return
			}
			responsesReply(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{}}`)
		})
		llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("test-model", userContent("run")), true)
		thought := first.Parts[0]
		if !thought.Thought || thought.Text != "done里想" {
			t.Fatalf("visible reasoning = %+v", thought)
		}
		if thought.PartMetadata[ReasoningReplayMetadataKey] == nil {
			t.Fatal("done fallback did not mark replay state")
		}
		finalContent(t, llm, replayToolReq("test-model", userContent("run"), first, userContent("next")), false)
		input := (*bodies)[1]["input"].([]any)
		reasoning := input[1].(map[string]any)
		if reasoning["type"] != "reasoning" || reasoning["encrypted_content"] != "enc-9" {
			t.Fatalf("reasoning item = %+v", reasoning)
		}
	})

	t.Run("channel switch does not replay", func(t *testing.T) {
		srv, bodies := replayServer(t, func(call int, w http.ResponseWriter) {
			responsesReply(w, `{"status":"completed","output":[
				{"id":"rs_4","type":"reasoning","summary":[{"type":"summary_text","text":"别带"}],"encrypted_content":"enc-4"},
				{"type":"function_call","call_id":"call_4","name":"echo","arguments":"{}"}
			],"usage":{}}`)
		})
		llm, err := NewLLM(testChannel(ProtocolResponses, srv.URL), &Options{})
		if err != nil {
			t.Fatal(err)
		}
		first := finalContent(t, llm, replayToolReq("test-model", userContent("run")), false)
		other := testChannel(ProtocolResponses, srv.URL)
		other.APIKey = "sk-other"
		llm2, err := NewLLM(other, &Options{})
		if err != nil {
			t.Fatal(err)
		}
		finalContent(t, llm2, replayToolReq("test-model", continuation(first, "call_4", "x")...), false)
		for _, raw := range (*bodies)[1]["input"].([]any) {
			item := raw.(map[string]any)
			if item["type"] == "reasoning" {
				t.Fatalf("channel switch must not replay reasoning: %v", item)
			}
		}
	})
}

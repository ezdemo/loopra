package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/provider"
	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/model/config"
)

type replayEchoArgs struct {
	Text string `json:"text" jsonschema:"要回显的文本"`
}

// assertResponsesReplay 校验一次 Responses 请求按原顺序回放了
// 加密推理条目，并且工具结果与调用按 id 配对。
func assertResponsesReplay(t *testing.T, body map[string]any) {
	t.Helper()
	if store, ok := body["store"].(bool); !ok || store {
		t.Fatalf("store = %v, want false", body["store"])
	}
	var reasoning, call, output map[string]any
	var types []string
	for _, raw := range body["input"].([]any) {
		item, _ := raw.(map[string]any)
		types = append(types, fmt.Sprint(item["type"]))
		switch item["type"] {
		case "reasoning":
			reasoning = item
		case "function_call":
			call = item
		case "function_call_output":
			output = item
		}
	}
	if reasoning == nil || reasoning["encrypted_content"] != "enc-1" || reasoning["id"] != "rs_1" {
		t.Fatalf("reasoning replay missing in input %v", types)
	}
	if call == nil || call["call_id"] != "call_1" {
		t.Fatalf("function_call missing in input %v", types)
	}
	if output == nil || output["call_id"] != "call_1" || output["output"] != "hi" {
		t.Fatalf("function_call_output = %v", output)
	}
}

// TestReasoningReplaySurvivesSessionReload 是原生通道的端到端回归：
// Responses 首轮经 SSE 返回加密推理条目与 echo 调用，同一轮内的
// 工具续接请求原样回放该条目；用新的 JSONL 会话服务重新打开同一
// 根目录后，新一轮请求仍然带着这份内部状态。
func TestReasoningReplaySurvivesSessionReload(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		mu.Lock()
		bodies = append(bodies, body)
		call := len(bodies) - 1
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if call == 0 {
			for _, f := range []string{
				`event: response.output_item.done` + "\n" + `data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"盘算"}],"encrypted_content":"enc-1"}}`,
				`event: response.output_item.added` + "\n" + `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"echo"}}`,
				`event: response.function_call_arguments.delta` + "\n" + `data: {"type":"response.function_call_arguments.delta","delta":"{\"text\":\"hi\"}"}`,
				`event: response.completed` + "\n" + `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2},"output":[{"id":"rs_1","type":"reasoning","summary":[]},{"type":"function_call","call_id":"call_1","name":"echo","arguments":"{\"text\":\"hi\"}"}]}}`,
			} {
				fmt.Fprint(w, f+"\n\n")
			}
			return
		}
		for _, f := range []string{
			`event: response.output_text.delta` + "\n" + `data: {"type":"response.output_text.delta","delta":"done"}`,
			`event: response.completed` + "\n" + `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}`,
		} {
			fmt.Fprint(w, f+"\n\n")
		}
	}))
	defer srv.Close()

	llm, err := provider.NewLLM(provider.Channel{
		ID: "ch1", Name: "Test", BaseURL: srv.URL, APIKey: "sk-t",
		APIProtocol: provider.ProtocolResponses,
		Models:      []provider.ModelEntry{{Name: "m1", MaxTokens: 4096}},
	}, &provider.Options{})
	if err != nil {
		t.Fatal(err)
	}
	echoTool, err := functiontool.New[replayEchoArgs, string](functiontool.Config{Name: "echo"},
		func(_ adkagent.Context, args replayEchoArgs) (string, error) {
			return args.Text, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	cfg := config.Default()
	a, err := New(root, "project", &cfg, Options{Model: llm, Tools: []tool.Tool{echoTool}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	sess, err := a.Session(ctx, "replay")
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for ev, err := range a.Run(ctx, sess, genai.NewContentFromText("run echo", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
		if ev.Content != nil {
			for _, p := range ev.Content.Parts {
				if p != nil && !p.Thought && p.Text != "" {
					texts = append(texts, p.Text)
				}
			}
		}
	}
	mu.Lock()
	got := len(bodies)
	mu.Unlock()
	if got != 2 {
		t.Fatalf("model calls = %d, want 2", got)
	}
	assertResponsesReplay(t, bodies[1])
	if len(texts) == 0 || texts[len(texts)-1] != "done" {
		t.Fatalf("final text = %v, want done", texts)
	}

	// 用全新的 JSONL 会话服务重新打开同一根目录：会话落盘的内部
	// 推理状态必须在新轮次里继续生效。
	reopened, err := New(root, "project", &cfg, Options{Model: llm, Tools: []tool.Tool{echoTool}, Sessions: jsonl.NewService(root)})
	if err != nil {
		t.Fatal(err)
	}
	sess2, err := reopened.Session(ctx, "replay")
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range reopened.Run(ctx, sess2, genai.NewContentFromText("again", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	got = len(bodies)
	mu.Unlock()
	if got != 3 {
		t.Fatalf("model calls after reload = %d, want 3", got)
	}
	assertResponsesReplay(t, bodies[2])
}

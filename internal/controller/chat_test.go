package controller

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	return newChatTestServer(t, nil)
}

func newChatTestServer(t *testing.T, runTool func(agentctx.Context) error) (*httptest.Server, string) {
	t.Helper()
	echoTool, err := functiontool.New[struct {
		Text string `json:"text"`
	}, map[string]any](functiontool.Config{Name: "echo", Description: "echo"},
		func(ctx agentctx.Context, in struct {
			Text string `json:"text"`
		}) (map[string]any, error) {
			if runTool != nil {
				if err := runTool(ctx); err != nil {
					return nil, err
				}
			}
			return map[string]any{"result": "echoed: " + in.Text}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := config.Default()
	a, err := agentpkg.New(root, "a1b2c3", &cfg, agentpkg.Options{
		Model: echo.New("scripted",
			echo.Script{Thought: "ponder", Text: "calling", ToolCalls: []*genai.FunctionCall{
				{Name: "echo", Args: map[string]any{"text": "hi"}},
			}},
			echo.Script{Text: "all done"},
		),
		Tools: []tool.Tool{echoTool},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key
}

// parseSSE 按照 loopra-front 的方式解码数据帧（契约 §0）。
func parseSSE(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, frame := range strings.Split(body, "\n\n") {
		frame = strings.TrimSpace(frame)
		if frame == "" {
			continue
		}
		var typ string
		var data string
		for _, line := range strings.Split(frame, "\n") {
			line = strings.TrimSuffix(line, "\r")
			switch {
			case strings.HasPrefix(line, "event: "):
				typ = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data += strings.TrimPrefix(line, "data: ")
			}
		}
		ev := map[string]any{"type": typ}
		var payload any
		if json.Unmarshal([]byte(data), &payload) == nil {
			if m, ok := payload.(map[string]any); ok {
				for k, v := range m {
					ev[k] = v
				}
			} else if s, ok := payload.(string); ok {
				ev["content"] = s
			}
		}
		out = append(out, ev)
	}
	return out
}

func eventTypes(evs []map[string]any) []string {
	types := make([]string, len(evs))
	for i, e := range evs {
		types[i] = e["type"].(string)
	}
	return types
}

func TestChatStreamContract(t *testing.T) {
	releaseTool := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(releaseTool) })
	defer unblock()
	ts, key := newChatTestServer(t, func(ctx agentctx.Context) error {
		select {
		case <-releaseTool:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	ts.Client().Timeout = 10 * time.Second
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"hello","sessionName":"s1","requestId":"r1"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status = %d, ct = %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	scanner := bufio.NewScanner(resp.Body)
	// 工具阻塞期间，首个模型事件已经落盘并上报过实测 prompt 用量。
	events, stop := readUntilEvent(t, scanner, "usage", "complete", "error", "done")
	if stop["type"] != "usage" {
		t.Fatalf("first stop event = %v, events=%v", stop, events)
	}
	if stop["promptTokens"] != float64(11) || stop["lastPromptTokens"] != float64(11) {
		t.Fatalf("first usage = %v", stop)
	}
	code, env := call(t, ts, http.MethodGet, "/api/usage?workspaceHash=a1b2c3&sessionName=s1", key, nil)
	if code != http.StatusOK {
		t.Fatalf("GET /api/usage status=%d env=%v", code, env)
	}
	data := env["data"].(map[string]any)
	if data["lastPromptTokens"] != float64(11) || data["measuredFresh"] != true {
		t.Fatalf("GET /api/usage data=%v", data)
	}
	unblock()
	tail, _ := readUntilEvent(t, scanner, "done")
	events = append(events, tail...)
	types := eventTypes(events)

	// 契约规定的顺序：snapshot → ... → complete → done。
	if types[0] != "snapshot" {
		t.Fatalf("first event = %q", types[0])
	}
	if types[len(types)-1] != "done" {
		t.Fatalf("last event = %q, events=%v", types[len(types)-1], events)
	}
	mustContain := []string{"snapshot", "reasoning_started", "reasoning", "tool_call", "tool_result", "usage", "complete", "done"}
	for _, want := range mustContain {
		found := false
		for _, typ := range types {
			if typ == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q event; got %v; events=%v", want, types, events)
		}
	}
	// 两次模型调用各发一条 usage：本条流内累计 prompt，lastPromptTokens
	// 始终是最近一次请求的实测值。
	var usagePos []int
	for i, typ := range types {
		if typ == "usage" {
			usagePos = append(usagePos, i)
		}
	}
	if len(usagePos) != 2 {
		t.Fatalf("usage events at %v, events=%v", usagePos, events)
	}
	first, second := events[usagePos[0]], events[usagePos[1]]
	if first["promptTokens"] != float64(11) || second["promptTokens"] != float64(22) {
		t.Fatalf("usage promptTokens: %v / %v", first, second)
	}
	if first["lastPromptTokens"] != float64(11) || second["lastPromptTokens"] != float64(11) {
		t.Fatalf("usage lastPromptTokens: %v / %v", first, second)
	}
	if usagePos[0] > slices.Index(types, "tool_result") {
		t.Fatalf("first usage must precede tool_result: %v", types)
	}
	if usagePos[1] > slices.Index(types, "complete") {
		t.Fatalf("second usage must precede complete: %v", types)
	}
	// content/reasoning 的负载为裸 JSON 字符串；思考只发一次 —— 流式增量已经
	// 送过，最终聚合事件不能把整段思考再补发一遍。
	reasoningEvents := 0
	for _, e := range events {
		if e["type"] == "reasoning" {
			reasoningEvents++
			if e["content"] != "ponder" {
				t.Fatalf("reasoning payload = %v", e)
			}
		}
	}
	if reasoningEvents != 1 {
		t.Fatalf("reasoning events = %d, want 1", reasoningEvents)
	}
	// tool_call 的结构：{toolCallId, name, args(JSON string)}。
	for _, e := range events {
		if e["type"] == "tool_call" {
			if e["name"] != "echo" || e["args"] == nil {
				t.Fatalf("tool_call = %v", e)
			}
			if _, ok := e["args"].(string); !ok {
				t.Fatalf("args must be a JSON string, got %T", e["args"])
			}
		}
	}
	// complete 携带最终的完整回复。
	var complete string
	for _, e := range events {
		if e["type"] == "complete" {
			complete, _ = e["content"].(string)
		}
	}
	if complete != "all done" {
		t.Fatalf("complete = %q, events=%v", complete, events)
	}
}

func TestChatStreamValidation(t *testing.T) {
	ts, key := newTestServer(t)
	cases := []struct {
		body   string
		status int
	}{
		{`{}`, 400},
		{`{"message":"hi","action":"bogus"}`, 400},
		{`{"message":"hi","mergeMode":"weird"}`, 400},
	}
	for _, c := range cases {
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(c.body))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != c.status {
			t.Fatalf("body %s: status = %d, want %d", c.body, resp.StatusCode, c.status)
		}
	}
}

func TestAccessKeyRequired(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := ts.Client().Post(ts.URL+"/api/chat/stream", "application/json",
		strings.NewReader(`{"message":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["reason"] != "access_key_required" || body["success"] != false {
		t.Fatalf("401 body = %v", body)
	}
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 1024)
	for {
		n, err := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return string(buf)
}

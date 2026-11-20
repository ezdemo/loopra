package controller

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	"github.com/ezdemo/looprax/internal/service/tools"
)

// streamSSE 逐帧解析 SSE 流，事件一到达就交给调用方（不像 readAll
// 那样等整个响应结束），用于验证结果的实时性。
func streamSSE(resp *http.Response) <-chan map[string]any {
	events := make(chan map[string]any, 16)
	go func() {
		defer close(events)
		reader := bufio.NewReader(resp.Body)
		for {
			var typ, data string
			for {
				line, err := reader.ReadString('\n')
				if err != nil {
					return
				}
				line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
				if line == "" {
					break
				}
				switch {
				case strings.HasPrefix(line, "event: "):
					typ = strings.TrimPrefix(line, "event: ")
				case strings.HasPrefix(line, "data: "):
					data = strings.TrimPrefix(line, "data: ")
				}
			}
			event := map[string]any{"type": typ}
			var payload any
			if json.Unmarshal([]byte(data), &payload) == nil {
				if fields, ok := payload.(map[string]any); ok {
					for key, value := range fields {
						event[key] = value
					}
				}
			}
			events <- event
		}
	}()
	return events
}

func TestAsyncToolKeepsStreamOpenAndCompletesOriginalRow(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	releaseSlow := func() { once.Do(func() { close(release) }) }
	slow, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "slow"}, func(ctx agentctx.Context, _ struct{}) (map[string]any, error) {
		select {
		case <-release:
			return map[string]any{"result": "async evidence"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := config.Default()
	a, err := agentpkg.New(root, "project", &cfg, agentpkg.Options{Model: echo.New("async",
		echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "slow-call", Name: "slow", Args: map[string]any{"yield_after_ms": 1}}}},
		echo.Script{Text: "waiting"}, echo.Script{Text: "done"}), Tools: []tool.Tool{tools.WithAsyncExecution(slow)}})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: root})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer releaseSlow()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream", strings.NewReader(`{"message":"run","sessionName":"async"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := streamSSE(resp)
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	waiting, completed, results, sawCall, updates := false, 0, 0, false, 0
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("stream closed without done")
			}
			switch event["type"] {
			case "tool_call":
				if event["toolCallId"] == "slow-call" {
					sawCall = true
				}
			case "tool_update":
				if event["toolCallId"] == "slow-call" {
					updates++
					if !sawCall || waiting || event["async"] != true || event["status"] != "running" {
						t.Fatalf("out-of-order or wrong async update: %v", event)
					}
				}
			case "content":
				// Text frames are JSON strings; streamSSE intentionally only
				// retains their type. The first text is the provisional answer.
				if !waiting {
					waiting = true
					if updates != 1 {
						t.Fatalf("async tool_update count = %d before first text", updates)
					}
					releaseSlow()
				}
			case "tool_result":
				if event["toolCallId"] == "slow-call" {
					results++
					if !waiting || event["result"] != "async evidence" || event["status"] != "completed" {
						t.Fatalf("premature or wrong result: %v", event)
					}
				}
			case "complete":
				completed++
				if event["content"] != "done" || results != 1 {
					t.Fatalf("premature completion: %v, results=%d", event, results)
				}
			case "error":
				t.Fatalf("stream error: %v", event)
			case "done":
				if results != 1 || completed != 1 || updates != 1 {
					t.Fatalf("results=%d complete=%d updates=%d", results, completed, updates)
				}
				return
			}
		case <-deadline.C:
			t.Fatal("async stream did not finish")
		}
	}
}

// tool_stop 只取消所属的后台调用：原调用上报一次取消终态，
// stop 自身是一次成功的普通工具结果，轮次随后正常结束。
func TestAsyncToolStopStreamsFinalResultWithoutEndingTurn(t *testing.T) {
	release := make(chan struct{})
	slow, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "slow"}, func(ctx agentctx.Context, _ struct{}) (map[string]any, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return map[string]any{"result": "fixture released"}, nil
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := config.Default()
	a, err := agentpkg.New(root, "project", &cfg, agentpkg.Options{Model: echo.New("stop",
		echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "slow-call", Name: "slow", Args: map[string]any{"yield_after_ms": 1}}}},
		echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "stop-call", Name: "tool_stop", Args: map[string]any{"call_id": "slow-call"}}}},
		echo.Script{Text: "done"}), Tools: []tool.Tool{tools.WithAsyncExecution(slow)}})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: root})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer close(release)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream", strings.NewReader(`{"message":"run","sessionName":"stop"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := streamSSE(resp)
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	results := map[string]map[string]any{}
	completed := 0
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("stream closed without done")
			}
			switch event["type"] {
			case "tool_result":
				if id, _ := event["toolCallId"].(string); id == "slow-call" || id == "stop-call" {
					if results[id] != nil {
						t.Fatalf("second terminal result for %s: %v", id, event)
					}
					results[id] = event
				}
			case "complete":
				completed++
				if event["content"] != "done" || results["slow-call"] == nil || results["stop-call"] == nil {
					t.Fatalf("premature completion: %v", event)
				}
			case "error":
				t.Fatalf("stream error: %v", event)
			case "done":
				slowResult, stopResult := results["slow-call"], results["stop-call"]
				if completed != 1 || slowResult == nil || stopResult == nil {
					t.Fatalf("completed=%d results=%v", completed, results)
				}
				if slowResult["status"] != "failed" {
					t.Fatalf("stopped call status = %v", slowResult["status"])
				}
				if text, _ := slowResult["result"].(string); !strings.Contains(text, "context canceled") {
					t.Fatalf("stopped call result = %v", slowResult["result"])
				}
				if stopResult["status"] != "completed" {
					t.Fatalf("stop call status = %v", stopResult["status"])
				}
				if text, _ := stopResult["result"].(string); !strings.Contains(text, "stopping") {
					t.Fatalf("stop call result = %v", stopResult["result"])
				}
				return
			}
		case <-deadline.C:
			t.Fatal("stop stream did not finish")
		}
	}
}

// 并行工具调用时，先完成的工具应立即上报 tool_result，而不是等
// 整批调用合并后才一起结束；合并事件到达时也不能重复上报。
func TestParallelToolResultsStreamOnCompletion(t *testing.T) {
	fast, err := functiontool.New[struct{}, map[string]any](
		functiontool.Config{Name: "fast_tool", Description: "立即完成"},
		func(agentctx.Context, struct{}) (map[string]any, error) {
			return map[string]any{"result": "fast done"}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseSlow := func() { releaseOnce.Do(func() { close(release) }) }
	slow, err := functiontool.New[struct{}, map[string]any](
		functiontool.Config{Name: "slow_tool", Description: "等待放行"},
		func(ctx agentctx.Context, _ struct{}) (map[string]any, error) {
			select {
			case <-release:
				return map[string]any{"result": "slow done"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	cfg := config.Default()
	a, err := agentpkg.New(root, "a1b2c3", &cfg, agentpkg.Options{
		Model: echo.New("parallel",
			echo.Script{ToolCalls: []*genai.FunctionCall{
				{ID: "call_fast", Name: "fast_tool"},
				{ID: "call_slow", Name: "slow_tool"},
			}},
			echo.Script{Text: "done"},
		),
		Tools: []tool.Tool{fast, slow},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Home: root})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	// 即使断言失败也要在关闭服务端之前放行慢工具，否则 handler
	// 不会返回，httptest.Server.Close 会一直等待。
	defer releaseSlow()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"run","sessionName":"parallel"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	events := streamSSE(resp)
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	counts := map[string]int{}
	fastSeen := false
wait:
	for {
		select {
		case event, ok := <-events:
			if !ok {
				break wait
			}
			if event["type"] == "done" {
				break wait
			}
			if event["type"] != "tool_result" {
				continue
			}
			id, _ := event["toolCallId"].(string)
			counts[id]++
			if id == "call_fast" && !fastSeen {
				fastSeen = true
				// 慢工具仍在阻塞；能走到这里说明快结果已实时到达。
				releaseSlow()
			}
		case <-deadline.C:
			t.Fatal("fast tool result did not stream while the slow tool was still running")
		}
	}
	if !fastSeen {
		t.Fatal("fast tool result was never reported")
	}
	if counts["call_fast"] != 1 || counts["call_slow"] != 1 {
		t.Fatalf("tool_result counts = %v", counts)
	}
}

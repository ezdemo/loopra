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

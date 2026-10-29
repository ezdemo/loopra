package controller

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// TestSubAgentFlow 通过聊天流驱动一次 sub_agent 往返：
// 父代理调用 sub_agent（脚本 0），子代理回复（脚本 1），
// 父代理汇总（脚本 2）；echo 模型在两个 runner 上
// 每次 GenerateContent 调用时依次推进。
func TestSubAgentFlow(t *testing.T) {
	reg := tools.NewRegistry(tools.FileTools(t.TempDir())...)
	cfg := config.Default()
	cfg.Hitl = "free"
	scripted := echo.New("scripted",
		echo.Script{ToolCalls: []*genai.FunctionCall{{
			Name: "sub_agent",
			Args: map[string]any{"name": "探索者", "profile": "explore", "task": "查看项目结构并总结"},
		}}},
		echo.Script{Text: "子代理完成：项目有 3 个文件"},
		echo.Script{Text: "子代理报告完毕"},
	)
	a, err := agentpkg.New(t.TempDir(), "a1b2c3", &cfg, agentpkg.Options{
		Model:    scripted,
		Toolsets: []tool.Toolset{reg},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Registry: reg, Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	// 通过流驱动一个聊天轮次
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"用子代理看看","sessionName":"main"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	events, done := readUntilEvent(t, scanner, "done")
	_ = done
	types := eventTypes(events)
	var subSessionID string
	var toolResult string
	for _, e := range events {
		switch e["type"] {
		case "sub_start":
			subSessionID, _ = e["subSessionId"].(string)
		case "tool_result":
			if n, _ := e["name"].(string); n == "sub_agent" {
				toolResult, _ = e["result"].(string)
			}
		}
	}
	for _, want := range []string{"sub_start", "sub_content", "sub_end", "complete"} {
		found := false
		for _, typ := range types {
			if typ == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q; events=%v", want, events)
		}
	}
	if subSessionID == "" || !strings.HasPrefix(subSessionID, "sub-") {
		t.Fatalf("subSessionId = %q", subSessionID)
	}
	if !strings.Contains(toolResult, "子代理完成") {
		t.Fatalf("sub_agent tool_result = %q, events=%v", toolResult, events)
	}

	// .sub 日志落在父会话旁边，包含 Loopra 的日志行
	dir := filepath.Join(srv.home, "workspace", "a1b2c3", "sessions", "main.sub")
	lines, err := readLines(filepath.Join(dir, subSessionID+".jsonl"))
	if err != nil {
		t.Fatalf(".sub log: %v (dir=%s)", err, dir)
	}
	first := decodeLine(t, lines[0])
	last := decodeLine(t, lines[len(lines)-1])
	if first["type"] != "sub_start" || last["type"] != "sub_end" || last["status"] != "completed" {
		t.Fatalf("log bracket lines = %v / %v", first, last)
	}

	// 子会话通过读取 API 暴露
	_, env := call(t, ts, http.MethodGet, "/api/sub-sessions?sessionName=main", key, nil)
	list := env["data"].([]any)
	if len(list) != 1 {
		t.Fatalf("sub list = %v", list)
	}
	info := list[0].(map[string]any)
	if info["subSessionId"] != subSessionID || info["status"] != "completed" {
		t.Fatalf("sub info = %v", info)
	}

	// 恢复聊天：驻留内存中的运行会回答后续消息
	req2, _ := http.NewRequest("POST", ts.URL+"/api/sub-sessions/"+subSessionID+"?sessionName=main",
		strings.NewReader(`{"message":"继续"}`))
	req2.Header.Set("X-Loopra-Key", key)
	resp2, err := ts.Client().Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("resume status = %d", resp2.StatusCode)
	}
	scanner2 := bufio.NewScanner(resp2.Body)
	scanner2.Buffer(make([]byte, 64*1024), 1024*1024)
	rev, done2 := readUntilEvent(t, scanner2, "done")
	_ = done2
	var resumed bool
	for _, e := range rev {
		if e["type"] == "sub_content" {
			resumed = true
		}
	}
	if !resumed {
		t.Fatalf("resume stream missing sub_content: %v", rev)
	}
	_ = os.Environ
}

// 子代理内部的并行工具调用同样应在完成时立即上报 sub_tool_result，
// 且 .sub 日志仍要记录合并事件里的结果（只去重 SSE，不去重审计日志）。
func TestSubAgentParallelToolResultsStreamOnCompletion(t *testing.T) {
	workspace := t.TempDir()
	reg := tools.NewRegistry(tools.FileTools(workspace)...)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseSlow := func() { releaseOnce.Do(func() { close(release) }) }

	fast, err := functiontool.New[struct{}, map[string]any](
		functiontool.Config{Name: "fast_tool", Description: "立即完成"},
		func(agentctx.Context, struct{}) (map[string]any, error) {
			return map[string]any{"result": "fast done"}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
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
	reg.Add(tools.Tool{Tool: fast, Meta: tools.Metadata{Name: "fast_tool", ReadOnly: true, AutoApprove: true}})
	reg.Add(tools.Tool{Tool: slow, Meta: tools.Metadata{Name: "slow_tool", ReadOnly: true, AutoApprove: true}})

	cfg := config.Default()
	cfg.Hitl = "free"
	scripted := echo.New("scripted",
		echo.Script{ToolCalls: []*genai.FunctionCall{{
			ID: "call_sub", Name: "sub_agent",
			Args: map[string]any{"name": "实现者", "profile": "implement", "task": "并行调用工具"},
		}}},
		echo.Script{ToolCalls: []*genai.FunctionCall{
			{ID: "sub_fast", Name: "fast_tool"},
			{ID: "sub_slow", Name: "slow_tool"},
		}},
		echo.Script{Text: "子代理完成"},
		echo.Script{Text: "父代理完成"},
	)
	a, err := agentpkg.New(t.TempDir(), "a1b2c3", &cfg, agentpkg.Options{
		Model: scripted, Toolsets: []tool.Toolset{reg},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, err := New(a, Options{Registry: reg, Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	defer releaseSlow() // 断言失败时也要先放行，避免关闭服务端时卡住

	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"用子代理并行跑","sessionName":"main"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	events := streamSSE(resp)
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	counts := map[string]int{}
	fastSeen := false
	subSessionID := ""
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
			if id, _ := event["subSessionId"].(string); id != "" {
				subSessionID = id
			}
			if event["type"] != "sub_tool_result" {
				continue
			}
			id, _ := event["toolCallId"].(string)
			counts[id]++
			if id == "sub_fast" && !fastSeen {
				fastSeen = true
				// 慢工具仍在阻塞；能走到这里说明子代理的快结果已实时到达。
				releaseSlow()
			}
		case <-deadline.C:
			t.Fatal("sub-agent fast tool result did not stream while the slow tool was still running")
		}
	}
	if !fastSeen {
		t.Fatal("sub-agent fast tool result was never reported")
	}
	if counts["sub_fast"] != 1 || counts["sub_slow"] != 1 {
		t.Fatalf("sub_tool_result counts = %v", counts)
	}
	if subSessionID == "" {
		t.Fatal("subSessionId was not reported")
	}

	// .sub 审计日志仍应在合并事件到达时记录两条结果。
	lines, err := readLines(filepath.Join(srv.home, "workspace", "a1b2c3", "sessions", "main.sub", subSessionID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	recorded := 0
	for _, line := range lines {
		if decodeLine(t, line)["type"] == "sub_tool_result" {
			recorded++
		}
	}
	if recorded != 2 {
		t.Fatalf("sub tool results recorded = %d, want 2", recorded)
	}
}

func decodeLine(t *testing.T, line string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("bad line %q: %v", line, err)
	}
	return m
}

func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, l := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out, nil
}

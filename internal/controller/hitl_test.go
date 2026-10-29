package controller

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// newHitlServer 组装一个服务器，其唯一工具 "danger" 由审批链
// 门控（hitl=approval、非只读、非工作区本地）。
func newHitlServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dangerTool := testDangerTool(t)
	reg := testRegistry(t, dangerTool)
	a, _ := testHitlAgent(t, reg)
	srv, key, err := New(a, Options{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key
}

func testDangerTool(t *testing.T) tool.Tool {
	t.Helper()
	dangerTool, err := functiontool.New[struct {
		Note string `json:"note"`
	}, map[string]any](functiontool.Config{Name: "danger", Description: "危险操作"},
		func(ctx agentctx.Context, in struct {
			Note string `json:"note"`
		}) (map[string]any, error) {
			return map[string]any{"result": "ran: " + in.Note}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	return dangerTool
}

func testRegistry(t *testing.T, dangerTool tool.Tool) *tools.Registry {
	t.Helper()
	return tools.NewRegistry(tools.Tool{
		Tool: dangerTool, Meta: tools.Metadata{Name: "danger", Description: "危险操作"},
	})
}

func testHitlAgent(t *testing.T, reg *tools.Registry) (*agentpkg.Agent, string) {
	t.Helper()
	root := t.TempDir()
	cfg := config.Default()
	cfg.Hitl = "approval"
	a, err := agentpkg.New(root, "a1b2c3", &cfg, agentpkg.Options{
		Model: echo.New("scripted",
			echo.Script{ToolCalls: []*genai.FunctionCall{
				{Name: "danger", Args: map[string]any{"note": "boom"}},
			}},
			echo.Script{Text: "finished after approval"},
		),
		Toolsets: []tool.Toolset{reg},
	})
	if err != nil {
		t.Fatal(err)
	}
	return a, root
}

// readUntilEvent 持续消费 SSE 帧，直到出现 want 中的某个类型，并
// 返回此前读到的所有帧。帧由多行拼装而成，直到
// 空行将其闭合。
func readUntilEvent(t *testing.T, scanner *bufio.Scanner, want ...string) ([]map[string]any, map[string]any) {
	t.Helper()
	var all []map[string]any
	var typ, data string
	flush := func() map[string]any {
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
		typ, data = "", ""
		return ev
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if typ == "" && data == "" {
				continue
			}
			ev := flush()
			all = append(all, ev)
			for _, w := range want {
				if ev["type"] == w {
					return all, ev
				}
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "event: "):
			typ = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data += strings.TrimPrefix(line, "data: ")
		}
	}
	t.Fatalf("stream ended before %v; got %v", want, all)
	return nil, nil
}

func TestChatHITLApprovalFlow(t *testing.T) {
	ts, key := newHitlServer(t)

	// 权限决定由第二个连接提交，此时
	// 流仍保持打开并等待。
	permissionCh := make(chan string, 1)
	go func() {
		id := <-permissionCh
		// 待处理列表首先显示该请求
		req, _ := http.NewRequest("GET", ts.URL+"/api/chat/permissions?sessionName=hitl1", nil)
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Errorf("permissions GET: %v", err)
			return
		}
		var body struct {
			Data []map[string]any `json:"data"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if len(body.Data) != 1 || body.Data[0]["permissionRequestId"] != id {
			t.Errorf("pending list = %v, want id %s", body.Data, id)
		}
		req, _ = http.NewRequest("POST", ts.URL+"/api/chat/permission",
			strings.NewReader(`{"workspaceHash":"a1b2c3","sessionName":"hitl1","permissionRequestId":"`+id+`","optionId":"allow_once"}`))
		req.Header.Set("X-Loopra-Key", key)
		resp, err = ts.Client().Do(req)
		if err != nil {
			t.Errorf("permission POST: %v", err)
			return
		}
		var ok struct {
			Data string `json:"data"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&ok)
		resp.Body.Close()
		if ok.Data != "审批已提交" {
			t.Errorf("permission reply = %q", ok.Data)
		}
	}()

	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"do it","sessionName":"hitl1"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	events, choice := readUntilEvent(t, scanner, "choice")
	if choice["permissionRequestId"] == nil {
		t.Fatalf("choice without id: %v", choice)
	}
	options, _ := choice["options"].([]any)
	if len(options) != 2 {
		t.Fatalf("choice options = %v", options)
	}
	// 做出选择之前，待处理的占位工具结果保持隐藏。
	for _, e := range events {
		if e["type"] == "tool_result" {
			t.Fatalf("pending tool_result leaked before choice: %v", e)
		}
	}

	permissionCh <- choice["permissionRequestId"].(string)

	events, done := readUntilEvent(t, scanner, "done")
	_ = done
	types := eventTypes(events)
	for _, want := range []string{"permission_resolved", "tool_result", "complete"} {
		found := false
		for _, typ := range types {
			if typ == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q after approval; events=%v", want, events)
		}
	}
	var toolResult string
	for _, e := range events {
		if e["type"] == "tool_result" {
			toolResult, _ = e["result"].(string)
		}
	}
	if !strings.Contains(toolResult, "ran: boom") {
		t.Fatalf("tool_result after approval = %q, events=%v", toolResult, events)
	}
	var complete string
	for _, e := range events {
		if e["type"] == "complete" {
			complete, _ = e["content"].(string)
		}
	}
	if complete != "finished after approval" {
		t.Fatalf("complete = %q", complete)
	}
}

func TestChatHITLDenyFlow(t *testing.T) {
	ts, key := newHitlServer(t)
	permissionCh := make(chan string, 1)
	go func() {
		id := <-permissionCh
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/permission",
			strings.NewReader(`{"workspaceHash":"a1b2c3","sessionName":"hitl2","permissionRequestId":"`+id+`","optionId":"reject_once"}`))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Errorf("permission POST: %v", err)
			return
		}
		resp.Body.Close()
	}()

	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"do it","sessionName":"hitl2"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	_, choice := readUntilEvent(t, scanner, "choice")
	permissionCh <- choice["permissionRequestId"].(string)

	events, _ := readUntilEvent(t, scanner, "done")
	var rejected bool
	for _, e := range events {
		if e["type"] == "tool_result" {
			if res, _ := e["result"].(string); strings.Contains(res, "rejected") {
				rejected = true
			}
		}
	}
	if !rejected {
		t.Fatalf("no rejected tool_result after deny; events=%v", events)
	}
}

// TestChatHITLAbortDuringApproval 在审批等待期间取消该轮次：
// 待处理请求以 cancelled 结束，流随之关闭。
func TestChatHITLAbortDuringApproval(t *testing.T) {
	ts, key := newHitlServer(t)
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"do it","sessionName":"hitl3","requestId":"abort-me"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	_, choice := readUntilEvent(t, scanner, "choice")

	// 在审批对话框弹出时中止进行中的轮次
	abort, _ := http.NewRequest("POST", ts.URL+"/api/chat/abort",
		strings.NewReader(`{"requestId":"abort-me","sessionName":"hitl3","workspaceHash":"a1b2c3"}`))
	abort.Header.Set("X-Loopra-Key", key)
	aresp, err := ts.Client().Do(abort)
	if err != nil {
		t.Fatal(err)
	}
	aresp.Body.Close()

	events, resolved := readUntilEvent(t, scanner, "permission_resolved")
	_ = choice
	if resolved["optionId"] != "cancelled" {
		t.Fatalf("abort must resolve as cancelled; got %v", resolved)
	}
	// 该会话的待处理注册表现在已为空
	pend, _ := http.NewRequest("GET", ts.URL+"/api/chat/permissions?sessionName=hitl3", nil)
	pend.Header.Set("X-Loopra-Key", key)
	presp, err := ts.Client().Do(pend)
	if err != nil {
		t.Fatal(err)
	}
	defer presp.Body.Close()
	var body struct {
		Data []any `json:"data"`
	}
	_ = json.NewDecoder(presp.Body).Decode(&body)
	if len(body.Data) != 0 {
		t.Fatalf("pending must be empty after abort, got %v; events=%v", body.Data, events)
	}
}

// TestPermissionStale 验证未知审批的 409 契约。
func TestPermissionStale(t *testing.T) {
	ts, key := newHitlServer(t)
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/permission",
		strings.NewReader(`{"workspaceHash":"a1b2c3","sessionName":"x","permissionRequestId":"nope","optionId":"allow_once"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale permission status = %d", resp.StatusCode)
	}
}

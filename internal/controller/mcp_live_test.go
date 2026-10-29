package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestMcpCheckAndToolsLive 以 streamable HTTP 运行进程内 MCP 服务，
// 并驱动真实的客户端路径：check 负责连接，tools 负责列举。
func TestMcpCheckAndToolsLive(t *testing.T) {
	server := mcp.NewServer(&mcp.Implementation{Name: "test-mcp", Version: "1.0"}, nil)
	server.AddTool(&mcp.Tool{
		Name:        "echo_tool",
		Description: "回显输入",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "ok"}},
		}, nil
	})
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	upstream := httptest.NewServer(mux)
	defer upstream.Close()

	ts, key, _, _ := newGitServer(t)
	// 注册线上服务器配置
	_, env := call(t, ts, http.MethodPost, "/api/mcp/servers/add", key,
		map[string]any{"name": "live", "type": "streamable", "url": upstream.URL + "/mcp"})
	if env["success"] != true {
		t.Fatalf("add = %v", env)
	}
	// check 拨通该服务器
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/check", key,
		map[string]any{"name": "live", "type": "streamable", "url": upstream.URL + "/mcp"})
	if env["data"] != "连接成功" {
		t.Fatalf("check = %v", env)
	}
	// tools 列举工具声明
	_, env = call(t, ts, http.MethodGet, "/api/mcp/servers/tools?name=live", key, nil)
	data := env["data"].(map[string]any)
	if data["connected"] != true {
		t.Fatalf("tools connected = %v", data)
	}
	tools := data["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v", tools)
	}
	entry := tools[0].(map[string]any)
	if entry["name"] != "echo_tool" {
		t.Fatalf("tool entry = %v", entry)
	}
	// 无法访问的端点会报告失败，而不是返回 500
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/check", key,
		map[string]any{"name": "dead", "type": "streamable", "url": "http://127.0.0.1:1/mcp"})
	if env["success"] != false || env["error"] != "连接失败，请检查服务器配置" {
		t.Fatalf("dead check = %v", env)
	}
}

package controller

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

var streamedCalls atomic.Uint64

func streamToolCall(w http.ResponseWriter, name string, args map[string]any) {
	arguments, _ := json.Marshal(args)
	event := map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"tool_calls": []any{map[string]any{
			"index": 0, "id": fmt.Sprintf("call_%s_%d", name, streamedCalls.Add(1)), "type": "function",
			"function": map[string]any{"name": name, "arguments": string(arguments)},
		}}},
		"finish_reason": "tool_calls",
	}}}
	data, _ := json.Marshal(event)
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
}

func streamDone(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
}

func requestToolNames(body map[string]any) map[string]bool {
	out := map[string]bool{}
	for _, entry := range body["tools"].([]any) {
		function, _ := entry.(map[string]any)["function"].(map[string]any)
		name, _ := function["name"].(string)
		out[name] = true
	}
	return out
}

func TestMcpBrokerKeepsRequestToolsIdentical(t *testing.T) {
	var executions, listings, calls atomic.Int32
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "large-fixture", Version: "1"}, nil)
	schemaMarker := strings.Repeat("DEFERRED_SCHEMA_PAYLOAD ", 60)
	for i := range 130 {
		name := fmt.Sprintf("fixture_%03d", i)
		mcpServer.AddTool(&mcp.Tool{
			Name: name, Description: "Read reference " + name,
			InputSchema: map[string]any{
				"type": "object", "required": []string{"value"},
				"properties": map[string]any{"value": map[string]any{"type": "string", "description": schemaMarker}},
			},
		}, func(_ context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			executions.Add(1)
			if request.Params.Name != "fixture_042" {
				t.Errorf("unexpected MCP dispatch: %s", request.Params.Name)
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "selected tool executed"}}}, nil
		})
	}
	transport := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, nil)
	mcpHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var message struct {
				Method string `json:"method"`
			}
			_ = json.Unmarshal(raw, &message)
			if message.Method == "tools/list" {
				listings.Add(1)
			}
			if message.Method == "tools/call" {
				calls.Add(1)
			}
		}
		transport.ServeHTTP(w, r)
	}))
	defer mcpHTTP.Close()
	var steps atomic.Int32
	var baseline atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			streamDone(w)
			return
		}
		names := requestToolNames(body)
		step := steps.Add(1)
		serialized, _ := json.Marshal(body["tools"])
		if step == 1 {
			baseline.Store(serialized)
		} else if !bytes.Equal(baseline.Load().([]byte), serialized) {
			t.Errorf("model request tools changed on step %d", step)
		}
		if !names["tool_search"] || !names["call_tool"] || bytes.Contains(serialized, []byte("DEFERRED_SCHEMA_PAYLOAD")) {
			t.Errorf("unstable broker definitions on step %d: %v", step, names)
		}
		for name := range names {
			if strings.HasPrefix(name, "mcp__") || strings.Contains(name, "fixture_") {
				t.Error("remote tool leaked into request tools")
			}
		}
		switch step {
		case 1:
			if listings.Load() != 0 {
				t.Error("initial request connected to MCP")
			}
			t.Logf("130 deferred MCP tools: all requests keep %d definitions, %d tool-schema bytes", len(names), len(serialized))
			streamToolCall(w, "tool_search", map[string]any{"query": "fixture_042", "limit": 1})
		case 2:
			messages, _ := json.Marshal(body["messages"])
			if !bytes.Contains(messages, []byte("DEFERRED_SCHEMA_PAYLOAD")) || listings.Load() != 1 {
				t.Error("tool_search did not return the selected full definition")
			}
			streamToolCall(w, "call_tool", map[string]any{"name": "fixture/fixture_042", "arguments": map[string]any{"value": 123}})
		case 3:
			messages, _ := json.Marshal(body["messages"])
			if executions.Load() != 0 || calls.Load() != 0 || !bytes.Contains(messages, []byte("do not match its parameters schema")) {
				t.Error("invalid arguments did not produce a local, recoverable validation error")
			}
			streamToolCall(w, "call_tool", map[string]any{"name": "fixture/fixture_042", "arguments": map[string]any{"value": "probe"}})
		case 4:
			if executions.Load() != 1 || listings.Load() != 1 {
				t.Error("broker dispatch failed or unnecessarily reloaded the catalog")
			}
			streamDone(w)
		case 5:
			if listings.Load() != 1 {
				t.Error("a different conversation eagerly connected to MCP")
			}
			streamDone(w)
		case 6:
			if listings.Load() != 1 {
				t.Error("a subsequent request eagerly restored MCP definitions")
			}
			streamToolCall(w, "call_tool", map[string]any{"name": "fixture/fixture_042", "arguments": map[string]any{"value": "known definition"}})
		case 7:
			if executions.Load() != 2 || calls.Load() != 2 || listings.Load() != 2 {
				t.Error("cold dispatch of a previously discovered reference failed")
			}
			streamDone(w)
		default:
			t.Errorf("unexpected model step %d", step)
			streamDone(w)
		}
	}))
	defer upstream.Close()
	ts, key, _, _ := parityServer(t, upstream.URL+"/v1")
	_, added := call(t, ts, http.MethodPost, "/api/mcp/servers/add", key, map[string]any{
		"name": "fixture", "type": "streamable", "url": mcpHTTP.URL,
	})
	if added["success"] != true {
		t.Fatal(added)
	}
	for _, session := range []string{"original", "isolated", "original"} {
		request, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
			strings.NewReader(fmt.Sprintf(`{"message":"read a reference","sessionName":%q}`, session)))
		request.Header.Set("X-Loopra-Key", key)
		response, err := ts.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if bytes.Contains(body, []byte("event: error")) || !bytes.Contains(body, []byte("event: done")) {
			t.Fatalf("chat failed: %s", body)
		}
	}
	if steps.Load() != 7 || executions.Load() != 2 {
		t.Fatalf("model steps=%d, executions=%d", steps.Load(), executions.Load())
	}
}

func TestMcpBrokerKeepsHumanApproval(t *testing.T) {
	for _, test := range []struct {
		name, decision string
		runs           int32
	}{
		{"read", "allow_once", 1}, {"deploy", "reject_once", 0},
	} {
		t.Run(test.name+"_"+test.decision, func(t *testing.T) { testMcpBrokerApproval(t, test.name, test.decision, test.runs) })
	}
}

func testMcpBrokerApproval(t *testing.T, toolName, decision string, expectedRuns int32) {
	var executions atomic.Int32
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "protected", Version: "1"}, nil)
	mcpServer.AddTool(&mcp.Tool{Name: toolName, InputSchema: map[string]any{"type": "object"}},
		func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			executions.Add(1)
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "approved"}}}, nil
		})
	mcpHTTP := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, nil))
	defer mcpHTTP.Close()
	var steps atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch steps.Add(1) {
		case 1:
			streamToolCall(w, "tool_search", map[string]any{"query": toolName, "limit": 1})
		case 2:
			streamToolCall(w, "call_tool", map[string]any{"name": "protected/" + toolName, "arguments": map[string]any{}})
		default:
			streamDone(w)
		}
	}))
	defer upstream.Close()
	ts, key, server, _ := parityServer(t, upstream.URL+"/v1")
	call(t, ts, http.MethodPost, "/api/mcp/servers/add", key, map[string]any{
		"name": "protected", "type": "streamable", "url": mcpHTTP.URL,
	})
	call(t, ts, http.MethodPut, "/api/config", key, map[string]any{"hitl": "approval"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"deploy","sessionName":"protected"}`))
	request.Header.Set("X-Loopra-Key", key)
	response, err := ts.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 65536), 1<<20)
	_, choice := readUntilEvent(t, scanner, "choice", "error")
	if choice["type"] == "error" {
		t.Fatal(choice)
	}
	if executions.Load() != 0 {
		t.Fatal("MCP tool executed before approval")
	}
	_, envelope := call(t, ts, http.MethodPost, "/api/chat/permission", key, map[string]any{
		"workspaceHash": server.agent.App(), "sessionName": "protected",
		"permissionRequestId": choice["permissionRequestId"], "optionId": decision,
	})
	if envelope["success"] != true {
		t.Fatal(envelope)
	}
	readUntilEvent(t, scanner, "done")
	if executions.Load() != expectedRuns {
		t.Fatalf("MCP tool executed %d times, expected %d", executions.Load(), expectedRuns)
	}
}

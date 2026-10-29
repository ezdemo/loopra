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
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ezdemo/looprax/internal/service"
	"github.com/ezdemo/looprax/internal/service/schedule"
)

func TestEngineMcpPreferencesReachModel(t *testing.T) {
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	mcpServer.AddTool(&mcp.Tool{Name: "fixture_tool", InputSchema: map[string]any{"type": "object"}}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "fixture"}}}, nil
	})
	mcpHTTP := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, nil))
	defer mcpHTTP.Close()
	observed := make(chan bool, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		messages, _ := body["messages"].([]any)
		lastRole := ""
		if len(messages) > 0 {
			lastRole, _ = messages[len(messages)-1].(map[string]any)["role"].(string)
		}
		if lastRole == "user" && strings.Contains(fmt.Sprint(body["tools"]), "tool_search") {
			streamToolCall(w, "tool_search", map[string]any{"query": "fixture_tool", "limit": 1})
			return
		}
		found := false
		if lastRole == "tool" {
			content, _ := messages[len(messages)-1].(map[string]any)["content"].(string)
			var result struct {
				Tools []struct {
					Name string `json:"name"`
				} `json:"tools"`
			}
			_ = json.Unmarshal([]byte(content), &result)
			for _, entry := range result.Tools {
				found = found || entry.Name == "fixture/fixture_tool"
			}
		}
		observed <- found
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	ts, key, _, _ := parityServer(t, upstream.URL+"/v1")
	_, env := call(t, ts, "POST", "/api/mcp/servers/add", key, map[string]any{"name": "fixture", "type": "streamable", "url": mcpHTTP.URL})
	if env["success"] != true {
		t.Fatalf("add = %v", env)
	}
	check := func(want bool) {
		t.Helper()
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(`{"message":"check tools","sessionName":"mcp-preferences"}`))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if bytes.Contains(raw, []byte("event: error")) {
			t.Fatalf("chat = %s", raw)
		}
		select {
		case got := <-observed:
			if got != want {
				t.Fatalf("MCP visible=%v, want %v", got, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("model not called")
		}
	}
	check(true)
	call(t, ts, "POST", "/api/mcp/servers/tools/save", key, map[string]any{"serverName": "fixture", "disallowedTools": []string{"fixture_tool"}})
	check(false)
	call(t, ts, "POST", "/api/mcp/servers/tools/save", key, map[string]any{"serverName": "fixture", "disallowedTools": []string{}})
	call(t, ts, "PUT", "/api/agent-engines/mcp", key, map[string]any{"agentId": "native", "name": "fixture", "enabled": false})
	check(false)
	call(t, ts, "PUT", "/api/agent-engines/mcp", key, map[string]any{"agentId": "native", "name": "fixture", "enabled": true})
	check(true)
}

func TestConcurrentScheduleCreatesDoNotLoseTasks(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	var workers sync.WaitGroup
	errors := make(chan error, 20)
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			body := fmt.Sprintf(`{"name":"task-%d","message":"disabled fixture","sessionName":"tasks","intervalSec":3600,"enabled":false}`, i)
			req, _ := http.NewRequest("POST", ts.URL+"/api/schedules", strings.NewReader(body))
			req.Header.Set("X-Loopra-Key", key)
			resp, err := ts.Client().Do(req)
			if err != nil {
				errors <- err
				return
			}
			defer resp.Body.Close()
			var envelope map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
				errors <- err
				return
			}
			if envelope["success"] != true {
				errors <- fmt.Errorf("create failed: %v", envelope)
			}
		}(i)
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	if got := len(s.tasks.List()); got != 20 {
		t.Fatalf("concurrent creates retained %d/20 tasks", got)
	}
	persisted := schedule.NewStore(schedule.Path(s.home, s.agent.App()))
	if got := len(persisted.Load()); got != 20 {
		t.Fatalf("disk retained %d/20 tasks", got)
	}
}

func TestSessionSettingsRemainPinnedAfterGlobalChanges(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	_, env := call(t, ts, "GET", "/api/sessions/pinned/settings", key, nil)
	before := env["data"].(map[string]any)
	original := before["model"]
	call(t, ts, "PUT", "/api/config", key, map[string]any{"model": "new-global-model"})
	_, env = call(t, ts, "GET", "/api/sessions/pinned/settings", key, nil)
	if env["data"].(map[string]any)["model"] != original {
		t.Fatal("global change replaced fixed session model")
	}
	meta := s.sessionMetaRead("pinned")
	if meta["model"] != original {
		t.Fatal("session defaults were not persisted")
	}
}

func TestCollectionDeleteClearsAllSessionsInSelectedProject(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	first := s.agent.App()
	for _, name := range []string{"one", "two"} {
		call(t, ts, "POST", "/api/sessions/new?sessionName="+name+"&workspaceHash="+first, key, nil)
		seedSessionMessage(t, s, first, name)
	}
	sub := filepath.Join(home, "workspace", first, "sessions", "one.sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "child.jsonl"), []byte("{}\n"), 0o600)
	other := filepath.Join(home, "other")
	os.MkdirAll(other, 0o755)
	call(t, ts, "POST", "/api/workspace", key, map[string]any{"path": other})
	second := service.WorkspaceHash(other)
	call(t, ts, "POST", "/api/sessions/new?sessionName=preserved&workspaceHash="+second, key, nil)
	seedSessionMessage(t, s, second, "preserved")
	_, env := call(t, ts, "DELETE", "/api/sessions?workspaceHash="+first, key, nil)
	data := env["data"].(map[string]any)
	if data["message"] != "所有会话已清空" || data["sessionName"] != nil {
		t.Fatalf("clear response = %v", data)
	}
	_, env = call(t, ts, "GET", "/api/sessions?workspaceHash="+first, key, nil)
	if len(env["data"].([]any)) != 0 {
		t.Fatal("collection delete left sessions")
	}
	if _, err := os.Stat(sub); !os.IsNotExist(err) {
		t.Fatal("collection delete left sub-session records")
	}
	_, env = call(t, ts, "GET", "/api/sessions?workspaceHash="+second, key, nil)
	if len(env["data"].([]any)) != 1 {
		t.Fatal("collection delete affected another project")
	}
}

func TestNativeEngineSelectorsPersistAndRestore(t *testing.T) {
	requests := make(chan map[string]any, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"configured\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	ts, key, s, _ := parityServer(t, upstream.URL+"/v1")
	call(t, ts, "POST", "/api/agent-engines/prepare", key, map[string]any{"sessionName": "selectors"})
	selections := map[string]string{"model": s.cfg.ModelChannelID + ":" + s.cfg.Model, "mode": "auto", "effort": "low", "fast": "on", "plan": "on"}
	for id, value := range selections {
		_, env := call(t, ts, "PUT", "/api/agent-engines/config", key, map[string]any{"sessionName": "selectors", "configId": id, "value": value})
		if env["success"] != true {
			t.Fatalf("%s = %v", id, env)
		}
	}
	_, env := call(t, ts, "POST", "/api/agent-engines/prepare", key, map[string]any{"sessionName": "fresh"})
	options := env["data"].(map[string]any)["configOptions"].([]any)
	if len(options) != 5 {
		t.Fatalf("selectors = %v", options)
	}
	for _, item := range options {
		option := item.(map[string]any)
		want := selections[option["id"].(string)]
		if option["id"] == "plan" {
			want = "off"
		}
		if option["currentValue"] != want {
			t.Fatalf("restored selector = %v, want %s", option, want)
		}
		for _, choice := range option["options"].([]any) {
			if _, ok := choice.(map[string]any)["value"]; !ok {
				t.Fatal("ACP choice omitted value")
			}
		}
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(`{"message":"hello","sessionName":"fresh"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if bytes.Contains(raw, []byte("event: error")) {
		t.Fatalf("chat = %s", raw)
	}
	select {
	case body := <-requests:
		if body["reasoning_effort"] != "low" || body["service_tier"] != "fast" {
			t.Fatalf("selectors did not reach model: effort=%v tier=%v", body["reasoning_effort"], body["service_tier"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("configured model not called")
	}
}

func TestModelMetadataRefreshPersistsAndChangesPrice(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"openrouter":{"models":{"fixture":{"cost":{"input":1,"output":2,"cache_read":0.1},"limit":{"context":8192}}}}}`)
	}))
	defer upstream.Close()
	t.Setenv("LOOPRA_MODEL_META_URL", upstream.URL)
	ts, key, s, home := parityServer(t, "")
	_, env := call(t, ts, "POST", "/api/model-meta/refresh", key, nil)
	if env["success"] != true {
		t.Fatalf("refresh = %v", env)
	}
	if _, err := os.Stat(filepath.Join(home, "model_meta.json")); err != nil {
		t.Fatal(err)
	}
	price, ok := s.metadataPrice("fixture")
	if !ok || price.Input != 7 || price.Output != 14 || price.Cache != 0.7 {
		t.Fatalf("price = %+v, found=%v", price, ok)
	}
}

func TestUpdaterRunsConfiguredHarmlessScript(t *testing.T) {
	ts, key, _, home := parityServer(t, "")
	script, content := filepath.Join(home, "fixture.sh"), "printf 'fixture-update-finished\\n'\n"
	if runtime.GOOS == "windows" {
		script, content = filepath.Join(home, "fixture.ps1"), "Write-Output 'fixture-update-finished'\n"
	}
	if err := os.WriteFile(script, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOOPRAX_UPDATE_SCRIPT", script)
	_, env := call(t, ts, "POST", "/api/version/update", key, map[string]any{})
	if env["success"] != true {
		t.Fatalf("start = %v", env)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_, env = call(t, ts, "GET", "/api/version/update", key, nil)
		status := env["data"].(map[string]any)
		if status["running"] == false {
			if status["state"] != "success" || !strings.Contains(status["log"].(string), "fixture-update-finished") {
				t.Fatalf("update = %v", status)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("update fixture did not complete")
}

func TestProjectDeletionProtectsBackgroundJobs(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	project := filepath.Join(home, "background-project")
	os.MkdirAll(project, 0o755)
	call(t, ts, "POST", "/api/workspace", key, map[string]any{"path": project})
	hash := service.WorkspaceHash(project)
	_, env := call(t, ts, "POST", "/api/requirements", key, map[string]any{"title": "Background", "projectHash": hash, "scheduleMode": "scheduled", "scheduledAt": time.Now().Add(time.Hour).UnixMilli()})
	item := env["data"].(map[string]any)
	id := item["id"].(string)
	if !s.reqs.Begin(id) {
		t.Fatal("could not mark requirement running")
	}
	code, _ := call(t, ts, "DELETE", "/api/workspaces/"+hash, key, nil)
	if code != http.StatusConflict {
		t.Fatalf("running requirement deletion = %d", code)
	}
	s.reqs.End(id)
	s.tasks.SetRunning(hash+":task", true)
	code, _ = call(t, ts, "DELETE", "/api/workspaces/"+hash, key, nil)
	if code != http.StatusConflict {
		t.Fatalf("running schedule deletion = %d", code)
	}
	s.tasks.SetRunning(hash+":task", false)
}

func TestCompatibilityBackendOwnsWholeSession(t *testing.T) {
	paths := make(chan string, 8)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Loopra-Key") != "backend-key" {
			t.Error("backend key not forwarded")
		}
		paths <- r.URL.Path
		if r.URL.Path == "/api/chat/stream" {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: content\ndata: \"from external engine\"\n\n")
			w.(http.Flusher).Flush()
			<-release
			fmt.Fprint(w, "event: done\ndata: {}\n\n")
			return
		}
		writeOK(w, 200, map[string]any{"runtime": "java"})
	}))
	ts, key, _, _ := parityServer(t, "")
	defer func() { close(release); upstream.Close() }()
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", upstream.URL)
	t.Setenv("LOOPRA_JAVA_BACKEND_KEY", "backend-key")
	for _, path := range []string{"/api/agent-engines", "/mcp"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("compatibility accepted unauthenticated %s: %d", path, resp.StatusCode)
		}
	}
	for _, path := range []string{"/api/agent-engines", "/api/agent/history?workspaceHash=backend-only", "/api/chat/elicitations?sessionName=external"} {
		_, env := call(t, ts, "GET", path, key, nil)
		if env["data"].(map[string]any)["runtime"] != "java" {
			t.Fatalf("mixed execution contexts: %v", env)
		}
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(`{"agentId":"external","message":"hello"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(resp.Body)
	readUntilEvent(t, scanner, "content")
	release <- struct{}{}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if len(paths) != 4 {
		t.Fatalf("delegated requests = %d", len(paths))
	}
}

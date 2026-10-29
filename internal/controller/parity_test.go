package controller

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func parityServer(t *testing.T, base string) (*httptest.Server, string, *Controller, string) {
	t.Helper()
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", "")
	home := t.TempDir()
	t.Setenv("LOOPRA_AGENTS_SKILLS_DIR", filepath.Join(home, "agents-skills"))
	workspace := filepath.Join(home, "project")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = workspace
	cfg.APIKey = "original-top-level-key"
	cfg.ModelChannels[0].APIKey = "original-channel-key"
	if base != "" {
		cfg.BaseURL = base
		cfg.ModelChannels[0].BaseURL = base
	}
	cfg.Extra = map[string]json.RawMessage{"futureSetting": json.RawMessage(`{"keep":true}`)}
	if err := repository.NewConfigRepository(home).Save(&cfg); err != nil {
		t.Fatal(err)
	}
	registry := tools.NewRegistry(tools.FileTools(workspace)...)
	a, err := agentpkg.New(home, service.WorkspaceHash(workspace), &cfg, agentpkg.Options{Toolsets: []tool.Toolset{registry}})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Registry: registry, Home: home, PetsDir: filepath.Join(home, "pets")})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); ts.Close() })
	return ts, key, s, home
}

func TestConfigPersistsSecretsAndUnknownSettings(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	_, env := call(t, ts, "GET", "/api/config", key, nil)
	view := env["data"].(map[string]any)
	if view["modelChannelsConfigured"] != true {
		t.Fatal("ConfigDTO omitted modelChannelsConfigured")
	}
	channels := view["modelChannels"].([]any)
	if strings.Contains(fmt.Sprint(channels), "original-channel-key") {
		t.Fatal("channel key leaked")
	}
	_, env = call(t, ts, "PUT", "/api/config", key, map[string]any{"model": "saved-model", "apiKey": view["apiKey"], "modelChannels": channels, "reasoningEffort": "low"})
	if env["success"] != true {
		t.Fatalf("save = %v", env)
	}
	reloaded, err := repository.NewConfigRepository(home).Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Model != "saved-model" || reloaded.APIKey != "original-top-level-key" || reloaded.ModelChannels[0].APIKey != "original-channel-key" {
		t.Fatalf("config = model:%s keys preserved:%v/%v", reloaded.Model, reloaded.APIKey == "original-top-level-key", reloaded.ModelChannels[0].APIKey == "original-channel-key")
	}
	if !bytes.Contains(reloaded.Extra["futureSetting"], []byte("keep")) {
		t.Fatal("unknown config lost")
	}
	// 新组装的运行时必须能看到已保存的模型。
	runtime, err := s.projectRuntime("")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.agent.Config().Model != "saved-model" {
		t.Fatal("runtime retained the old model")
	}
}

func TestPlanSubmissionAndExecution(t *testing.T) {
	home := t.TempDir()
	workspace := filepath.Join(home, "project")
	os.MkdirAll(workspace, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = workspace
	reg := tools.NewRegistry(tools.FileTools(workspace)...)
	script := echo.New("plan-script", echo.Script{ToolCalls: []*genai.FunctionCall{{Name: "submit_plan", Args: map[string]any{"steps": "[\"Inspect code\",\"Apply fix\"]", "summary": "Repair"}}}}, echo.Script{Text: "Plan ready"}, echo.Script{Text: "Executed"})
	a, err := agentpkg.New(home, service.WorkspaceHash(workspace), &cfg, agentpkg.Options{Model: script, Toolsets: []tool.Toolset{reg}})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Home: home, Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); ts.Close() })
	call(t, ts, "POST", "/api/agent/mode", key, map[string]any{"sessionName": "plan", "enabled": true})
	chat := func(body string) []byte {
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(body))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return raw
	}
	raw := chat(`{"message":"Plan the change","sessionName":"plan"}`)
	if !bytes.Contains(raw, []byte("plan_submitted")) {
		t.Fatalf("plan stream = %s", raw)
	}
	_, env := call(t, ts, "GET", "/api/agent/mode?sessionName=plan", key, nil)
	if !strings.Contains(env["data"].(map[string]any)["pendingPlan"].(string), "Apply fix") {
		t.Fatal("plan was not persisted")
	}
	raw = chat(`{"action":"execute_plan","sessionName":"plan"}`)
	if !bytes.Contains(raw, []byte("Executed")) {
		t.Fatalf("execute stream = %s", raw)
	}
	_, env = call(t, ts, "GET", "/api/agent/mode?sessionName=plan", key, nil)
	if env["data"].(map[string]any)["mode"] != "execute" {
		t.Fatal("execution did not leave plan mode")
	}
}

func TestChatWritesIntoSessionWorktree(t *testing.T) {
	if !gitops.Available() {
		t.Skip("git required")
	}
	home := t.TempDir()
	workspace := filepath.Join(home, "project")
	os.MkdirAll(workspace, 0o755)
	run := gitops.Runner{Dir: workspace}
	run.Git(gitops.TimeoutQuery, "init", "-q")
	run.Git(gitops.TimeoutQuery, "config", "user.email", "test@loopra")
	run.Git(gitops.TimeoutQuery, "config", "user.name", "Test")
	os.WriteFile(filepath.Join(workspace, "base.txt"), []byte("base"), 0o600)
	run.Git(gitops.TimeoutQuery, "add", "base.txt")
	if _, stderr, err := run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "initial"); err != nil {
		t.Fatal(stderr)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = workspace
	reg := tools.NewRegistry(tools.FileTools(workspace)...)
	script := echo.New("worktree-script", echo.Script{ToolCalls: []*genai.FunctionCall{{Name: "write", Args: map[string]any{"path": "sandbox.txt", "content": "isolated"}}}}, echo.Script{Text: "Done"})
	a, err := agentpkg.New(home, service.WorkspaceHash(workspace), &cfg, agentpkg.Options{Model: script, Toolsets: []tool.Toolset{reg}})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Home: home, Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); ts.Close() })
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(`{"message":"Make an isolated change","sessionName":"sandbox","worktreeMode":true}`))
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
	target := gitops.WorktreePath(s.worktreeBase(), s.agent.App(), "sandbox")
	turn, err := s.prepareTurn(&chatRequest{SessionName: "sandbox"})
	if err != nil {
		t.Fatal(err)
	}
	for _, prompt := range []string{turn.agent.Instruction(), turn.subRunner.Environment} {
		if !strings.Contains(prompt, "Working directory: "+target) {
			t.Fatalf("worktree prompt has the wrong working directory: %s", prompt)
		}
	}
	turn.closeTurnTools()
	if content, err := os.ReadFile(filepath.Join(target, "sandbox.txt")); err != nil || string(content) != "isolated" {
		t.Fatal("write did not reach the worktree", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, "sandbox.txt")); !os.IsNotExist(err) {
		t.Fatal("worktree chat modified the main workspace")
	}
	messages := s.sessionMessages(context.Background(), "sandbox")
	snapshotID, _ := messages[0]["rollback_id"].(string)
	if snapshotID == "" {
		t.Fatal("chat did not persist its code snapshot")
	}
	os.WriteFile(filepath.Join(target, "base.txt"), []byte("sandbox changed"), 0o600)
	os.WriteFile(filepath.Join(workspace, "base.txt"), []byte("main preserved"), 0o600)
	call(t, ts, "PUT", "/api/sessions/sandbox/worktree", key, map[string]any{"worktreeMode": false})
	_, env := call(t, ts, "POST", "/api/snapshots/rollback", key, map[string]any{"msgId": snapshotID, "sessionName": "other"})
	if env["success"] != false {
		t.Fatal("rollback accepted another session's snapshot")
	}
	_, env = call(t, ts, "POST", "/api/snapshots/rollback", key, map[string]any{"msgId": snapshotID, "sessionName": "sandbox"})
	if env["success"] != true {
		t.Fatalf("sandbox rollback = %v", env)
	}
	if data, _ := os.ReadFile(filepath.Join(workspace, "base.txt")); string(data) != "main preserved" {
		t.Fatal("sandbox rollback modified the main workspace")
	}
	if data, _ := os.ReadFile(filepath.Join(target, "base.txt")); string(data) != "base" {
		t.Fatal("sandbox rollback did not restore its original directory")
	}
}

func TestWorkspaceIsolationAndSessionMetadata(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	first := s.agent.App()
	call(t, ts, "POST", "/api/sessions/new?sessionName=same&workspaceHash="+first, key, nil)
	seedSessionMessage(t, s, first, "same")
	call(t, ts, "PUT", "/api/sessions/same/title?workspaceHash="+first, key, map[string]any{"title": "first title"})
	secondPath := filepath.Join(home, "second")
	os.MkdirAll(secondPath, 0o755)
	_, env := call(t, ts, "POST", "/api/workspace", key, map[string]any{"path": secondPath})
	if env["success"] != true {
		t.Fatalf("switch = %v", env)
	}
	second := service.WorkspaceHash(secondPath)
	call(t, ts, "POST", "/api/sessions/new?sessionName=same&workspaceHash="+second, key, nil)
	seedSessionMessage(t, s, second, "same")
	call(t, ts, "PUT", "/api/sessions/same/title?workspaceHash="+second, key, map[string]any{"title": "second title"})
	for hash, want := range map[string]string{first: "first title", second: "second title"} {
		_, env = call(t, ts, "GET", "/api/sessions?workspaceHash="+hash, key, nil)
		rows := env["data"].([]any)
		if len(rows) != 1 || rows[0].(map[string]any)["title"] != want {
			t.Fatalf("workspace %s = %v", hash, rows)
		}
	}
	_, env = call(t, ts, "GET", "/api/sessions?workspaceHash=does-not-exist", key, nil)
	if env["success"] != false {
		t.Fatal("unknown workspace silently used the current project")
	}
	// 有消息的会话在重启后仍然存在。
	runtime, err := s.projectRuntime(first)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := agentpkg.New(home, first, runtime.cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fresh.Sessions.Get(context.Background(), getSessionRequest(fresh, "same")); err != nil {
		t.Fatal("persisted session did not survive restart", err)
	}
	// 只新建、未发送消息的会话既不落盘，也不出现在列表或重启后的进程里。
	call(t, ts, "POST", "/api/sessions/new?sessionName=pending&workspaceHash="+first, key, nil)
	_, env = call(t, ts, "GET", "/api/sessions?workspaceHash="+first, key, nil)
	if rows := env["data"].([]any); len(rows) != 1 {
		t.Fatalf("pending session leaked into the list: %v", rows)
	}
	if _, err = fresh.Sessions.Get(context.Background(), getSessionRequest(fresh, "pending")); err == nil {
		t.Fatal("pending session was persisted before its first message")
	}
}

func TestRemoteModelsAndTurnOverrides(t *testing.T) {
	requested := make(chan string, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			writeJSON(w, 200, map[string]any{"data": []map[string]string{{"id": "z"}, {"id": "a"}}})
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		model, _ := body["model"].(string)
		requested <- model
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":%q},\"finish_reason\":null}]}\n\ndata: {\"id\":\"t\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", "served:"+model)
	}))
	defer upstream.Close()
	ts, key, s, _ := parityServer(t, upstream.URL+"/v1")
	_, env := call(t, ts, "GET", "/api/remote-models", key, nil)
	if fmt.Sprint(env["data"]) != "[a z]" {
		t.Fatalf("models = %v", env)
	}
	call(t, ts, "POST", "/api/sessions/new?sessionName=models", key, nil)
	call(t, ts, "PUT", "/api/sessions/models/settings", key, map[string]any{"model": "session-model"})
	for _, override := range []string{"", "request-model"} {
		body := map[string]any{"message": "hello", "sessionName": "models"}
		if override != "" {
			body["model"] = override
		}
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", bytes.NewReader(raw))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !bytes.Contains(data, []byte("served:")) {
			t.Fatalf("chat = %d %s", resp.StatusCode, data)
		}
		select {
		case model := <-requested:
			want := override
			if want == "" {
				want = "session-model"
			}
			if model != want {
				t.Fatalf("model = %q, want %q", model, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("model was not called")
		}
	}
	if s.configSnapshot().Model == "request-model" {
		t.Fatal("request override changed global config")
	}
}

func TestLoopraContractRoutesReachHandlers(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/releases/latest" {
			w.Header().Set("Location", "https://example.invalid/releases/tag/v0.2.0")
			w.WriteHeader(302)
			return
		}
		if r.URL.Path == "/metadata" {
			writeJSON(w, 200, map[string]any{"provider": map[string]any{"models": map[string]any{}}})
			return
		}
		writeJSON(w, 200, map[string]any{"data": []any{}})
	}))
	defer upstream.Close()
	ts, key, s, home := parityServer(t, upstream.URL)
	t.Setenv("LOOPRA_MODEL_META_URL", upstream.URL+"/metadata")
	t.Setenv("LOOPRAX_RELEASE_LATEST_URL", upstream.URL+"/releases/latest")
	t.Setenv("LOOPRA_SKILLHUB_URL", upstream.URL)
	t.Setenv("LOOPRA_CLAWHUB_URL", upstream.URL)
	script := filepath.Join(home, "noop.sh")
	content := "exit 0\n"
	if runtime.GOOS == "windows" {
		script = filepath.Join(home, "noop.ps1")
		content = "Write-Output 'fixture updater'\n"
	}
	if err := os.WriteFile(script, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOOPRAX_UPDATE_SCRIPT", script)
	data, err := os.Open(filepath.Join("..", "..", "docs", "API_PARITY_AUDIT.csv"))
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	rows, err := csv.NewReader(data).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows[1:] {
		method, path := row[1], row[2]
		path = regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(path, "audit-missing")
		t.Run(method+" "+path, func(t *testing.T) {
			if path == "/api/system/pick-directory" {
				t.Skip("requires an interactive desktop")
			}
			if strings.HasSuffix(path, "/spritesheet") {
				req, _ := http.NewRequest(method, ts.URL+path, nil)
				req.Header.Set("X-Loopra-Key", key)
				resp, err := ts.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if resp.StatusCode != 404 {
					t.Fatalf("missing pet image = %d", resp.StatusCode)
				}
				return
			}
			code, envelope := call(t, ts, method, path+"?workspaceHash="+s.agent.App()+"&sessionName=audit", key, map[string]any{})
			if code == 405 || (code == 404 && envelope["error"] == "未找到路径") || code >= 500 {
				t.Fatalf("contract route is still unreachable: HTTP %d", code)
			}
		})
	}
}

func TestOpenapiRegistrationSearchRefreshAndRemoval(t *testing.T) {
	var title atomic.Value
	title.Store("订单查询")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer doc-token" {
			w.WriteHeader(401)
			return
		}
		writeJSON(w, 200, map[string]any{"openapi": "3.0.0", "paths": map[string]any{"/orders": map[string]any{"get": map[string]any{"summary": title.Load()}}}})
	}))
	defer upstream.Close()
	ts, key, _, home := parityServer(t, "")
	body := map[string]any{"docUrl": upstream.URL, "authType": "bearer", "authConfig": map[string]string{"token": "doc-token"}}
	_, env := call(t, ts, "POST", "/api/openapi/sources", key, body)
	if env["success"] != true {
		t.Fatalf("register = %v", env)
	}
	_, env = call(t, ts, "GET", "/api/openapi/search?keyword="+url.QueryEscape("订单 查询"), key, nil)
	if len(env["data"].([]any)) != 1 {
		t.Fatalf("search = %v", env)
	}
	if _, err := os.Stat(filepath.Join(home, "openapi-sources.json")); err != nil {
		t.Fatal(err)
	}
	title.Store("库存修改")
	call(t, ts, "PUT", "/api/openapi/sources/refresh", key, body)
	_, env = call(t, ts, "GET", "/api/openapi/search?keyword="+url.QueryEscape("订单"), key, nil)
	if len(env["data"].([]any)) != 0 {
		t.Fatal("refresh retained the old document")
	}
	call(t, ts, "DELETE", "/api/openapi/sources", key, map[string]any{"docUrl": upstream.URL})
	_, env = call(t, ts, "GET", "/api/openapi/sources", key, nil)
	if len(env["data"].([]any)) != 0 {
		t.Fatal("source was not removed")
	}
}

func TestMarketInstallsArchiveAndRejectsEscapes(t *testing.T) {
	var archive bytes.Buffer
	zipper := zip.NewWriter(&archive)
	file, _ := zipper.Create("SKILL.md")
	file.Write([]byte("---\nname: Audit Skill\ndescription: local fixture\n---\nUse this skill."))
	zipper.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/download") {
			w.Write(archive.Bytes())
			return
		}
		writeJSON(w, 200, map[string]any{"skill": map[string]any{"slug": "audit-skill", "displayName": "Audit Skill"}})
	}))
	defer upstream.Close()
	t.Setenv("LOOPRA_SKILLHUB_URL", upstream.URL)
	ts, key, _, home := parityServer(t, "")
	_, env := call(t, ts, "POST", "/api/skill-market/install?slug=audit-skill", key, nil)
	if env["success"] != true {
		t.Fatalf("install = %v", env)
	}
	if _, err := os.Stat(filepath.Join(home, "skills", "audit-skill", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	call(t, ts, "POST", "/api/skill-market/uninstall?slug=audit-skill", key, nil)
	if _, err := os.Stat(filepath.Join(home, "skills", "audit-skill")); !os.IsNotExist(err) {
		t.Fatal("skill was not removed")
	}
	var unsafe bytes.Buffer
	writer := zip.NewWriter(&unsafe)
	entry, _ := writer.Create("../escape.txt")
	entry.Write([]byte("bad"))
	writer.Close()
	if err := extractSkill(unsafe.Bytes(), t.TempDir()); err == nil {
		t.Fatal("archive path traversal accepted")
	}
}

func TestDisconnectKeepsChatRunningAndAbortTargetsRequest(t *testing.T) {
	started := make(chan string, 4)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		started <- fmt.Sprint(body["model"])
		select {
		case <-release:
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"finished\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	defer close(release)
	ts, key, s, _ := parityServer(t, upstream.URL+"/v1")
	open := func(id, name string) *http.Response {
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(fmt.Sprintf(`{"message":"work","requestId":%q,"sessionName":%q}`, id, name)))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(resp.Body)
		readUntilEvent(t, scanner, "snapshot")
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("upstream did not start")
		}
		return resp
	}
	first := open("request-one", "one")
	second := open("request-two", "two")
	defer first.Body.Close()
	defer second.Body.Close()
	second.Body.Close()
	_, env := call(t, ts, "GET", "/api/agent/session-status?sessionName=two", key, nil)
	if env["data"].(map[string]any)["running"] != true {
		t.Fatal("disconnect cancelled the chat")
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(`{"message":"duplicate","requestId":"request-one","sessionName":"another"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !bytes.Contains(raw, []byte("requestId")) || !bytes.Contains(raw, []byte("event: error")) {
		t.Fatalf("duplicate request = %s", raw)
	}
	call(t, ts, "POST", "/api/chat/abort", key, map[string]any{"requestId": "request-one"})
	deadline := time.Now().Add(3 * time.Second)
	for s.sessionRunning("one") != "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if s.sessionRunning("one") != "" {
		t.Fatal("target request was not aborted")
	}
	if s.sessionRunning("two") == "" {
		t.Fatal("aborting one request cancelled the other")
	}
}

func TestMcpExportServesRealTools(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	if err := os.WriteFile(filepath.Join(s.workspaceRoot(), "hello.txt"), []byte("exported file content"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, env := call(t, ts, "PUT", "/api/mcp/export", key, map[string]any{"enabled": true, "allowedTools": []string{"read"}, "channel": "streamable_stateless"})
	if env["success"] != true {
		t.Fatalf("enable = %v", env)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "parity-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: ts.URL + "/mcp", HTTPClient: &http.Client{Transport: headerTransport{Headers: map[string]string{"X-Loopra-Key": key}}}, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	list, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Tools) != 1 || list.Tools[0].Name != "read" {
		t.Fatalf("exported tools = %v", list.Tools)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "read", Arguments: map[string]any{"path": "hello.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(result)
	if result.IsError || !bytes.Contains(raw, []byte("exported file content")) {
		t.Fatalf("call = %s", raw)
	}
	req, _ := http.NewRequest("POST", ts.URL+"/mcp", strings.NewReader(`{}`))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("MCP endpoint accepted an unauthenticated request")
	}
}

func TestHistoryRollbackPreservesAudit(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	call(t, ts, "POST", "/api/sessions/new?sessionName=history", key, nil)
	dir := filepath.Join(home, "workspace", s.agent.App(), "sessions")
	raw := []byte("{\"role\":\"user\",\"content\":\"first\",\"rollback_id\":\"snap-one\",\"timestamp\":100}\n{\"role\":\"assistant\",\"content\":\"answer\",\"timestamp\":200}\n{\"role\":\"user\",\"content\":\"second\",\"rollback_id\":\"snap-two\",\"timestamp\":300}\n{\"role\":\"assistant\",\"content\":\"later\",\"timestamp\":400}\n")
	if err := os.WriteFile(filepath.Join(dir, "history.jsonl"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "history.events"), raw, 0o600)
	_, env := call(t, ts, "POST", "/api/snapshots/rollback", key, map[string]any{"sessionName": "history", "msgId": "snap-two", "rollbackCode": false})
	if env["success"] != true || env["data"].(map[string]any)["rollbackUserText"] != "second" {
		t.Fatalf("rollback = %v", env)
	}
	_, env = call(t, ts, "GET", "/api/agent/history?sessionName=history", key, nil)
	if len(env["data"].([]any)) != 2 {
		t.Fatalf("visible history = %v", env)
	}
	_, env = call(t, ts, "GET", "/api/agent/history/events?sessionName=history", key, nil)
	if len(env["data"].([]any)) != 4 {
		t.Fatal("rollback rewrote append-only audit history")
	}
}

// MCP 导出的工具调用属于内部派发，整个调用期间都不能在用户会话目录
// 里物化临时会话（Java 直接 delegate，不创建会话）。
func TestMcpExportUsesIsolatedSessionStore(t *testing.T) {
	_, _, s, home := parityServer(t, "")
	started, release := make(chan struct{}), make(chan struct{})
	blocking, err := functiontool.New[struct{}, map[string]any](
		functiontool.Config{Name: "blocking_tool", Description: "测试用阻塞工具"},
		func(ctx agent.Context, _ struct{}) (map[string]any, error) {
			close(started)
			<-release
			return map[string]any{"result": "done"}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	s.registry.Add(tools.Tool{Tool: blocking, Meta: tools.Metadata{Name: "blocking_tool", ReadOnly: true, AutoApprove: true}})
	done := make(chan error, 1)
	go func() {
		_, err := s.callExportTool(context.Background(), "blocking_tool", map[string]any{})
		done <- err
	}()
	<-started
	entries, err := os.ReadDir(filepath.Join(home, "workspace", s.agent.App(), "sessions"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("export materialized sessions in the user store: %v", names)
	}
}

func TestTunnelProxyOnlyExposesMcp(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "upstream:"+r.URL.Path) }))
	defer upstream.Close()
	proxy, origin, err := startTunnelProxy(strings.TrimPrefix(upstream.URL, "http://"), "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	for path, want := range map[string]int{"/mcp": 200, "/mcp/messages": 200, "/api/config": 404, "/": 404, "/mcp-other": 404} {
		resp, err := http.Get(origin + path)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s = %d, want %d", path, resp.StatusCode, want)
		}
	}
}

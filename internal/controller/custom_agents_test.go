package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/service"
	"github.com/ezdemo/looprax/internal/service/customagent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func postAgent(t *testing.T, ts *httptest.Server, key string, body map[string]any) (int, map[string]any) {
	t.Helper()
	return call(t, ts, "POST", "/api/custom-agents", key, body)
}

func TestCustomAgentCRUDOverHTTP(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	code, env := call(t, ts, "GET", "/api/custom-agents", key, nil)
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("list = %d %v", code, env)
	}
	if list, _ := env["data"].([]any); len(list) != 0 {
		t.Fatalf("empty list = %v", list)
	}
	code, env = postAgent(t, ts, key, map[string]any{"name": "译员", "instruction": "把回复翻译成英文"})
	if code != http.StatusOK {
		t.Fatalf("create = %d %v", code, env)
	}
	agent := env["data"].(map[string]any)
	id := agent["id"].(string)
	if !customagent.IsID(id) || agent["name"] != "译员" {
		t.Fatalf("agent = %v", agent)
	}
	if agent["tools"] != nil || agent["skills"] != nil {
		t.Fatalf("缺省应为 null: %v", agent)
	}
	// 重名、保留名、坏 id、坏 projectHash。
	for _, body := range []map[string]any{
		{"name": "译员"}, {"name": "纯聊天"}, {"name": ""},
		{"name": "x", "projectHash": chatWorkspace},
		{"name": "x", "projectHash": "agent_0123456789ab"},
		{"name": "x", "projectHash": "deadbeefdead"},
	} {
		if code, env := postAgent(t, ts, key, body); code != http.StatusBadRequest {
			t.Fatalf("body %v = %d %v", body, code, env)
		}
	}
	code, env = call(t, ts, "PUT", "/api/custom-agents/"+id, key, map[string]any{
		"name": "译员2", "instruction": "in2", "tools": []string{" read ", "read"}, "skills": []string{},
	})
	if code != http.StatusOK {
		t.Fatalf("update = %d %v", code, env)
	}
	updated := env["data"].(map[string]any)
	if updated["name"] != "译员2" || updated["createdAt"] != agent["createdAt"] || updated["updatedAt"].(float64) < agent["createdAt"].(float64) {
		t.Fatalf("updated = %v", updated)
	}
	if tools := updated["tools"].([]any); len(tools) != 1 {
		t.Fatalf("tools dedupe = %v", tools)
	}
	if skills, ok := updated["skills"].([]any); !ok || len(skills) != 0 {
		t.Fatalf("skills = %v", updated["skills"])
	}
	if code, _ := call(t, ts, "PUT", "/api/custom-agents/agent_0123456789ab", key, map[string]any{"name": "x"}); code != http.StatusNotFound {
		t.Fatalf("update missing = %d", code)
	}
	// 方法语义：405 由 routeGuard 返回纯文本。
	req, err := http.NewRequest(http.MethodPatch, ts.URL+"/api/custom-agents", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("patch = %d", resp.StatusCode)
	}
	// 会话目录随定义一起删除。
	sessions := filepath.Join(home, "workspace", id, "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessions, "s.jsonl"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _ = call(t, ts, "DELETE", "/api/custom-agents/"+id, key, nil)
	if code != http.StatusOK {
		t.Fatalf("delete = %d", code)
	}
	if _, err := os.Stat(filepath.Join(home, "workspace", id)); !os.IsNotExist(err) {
		t.Fatalf("workspace dir remains: %v", err)
	}
	if code, _ := call(t, ts, "DELETE", "/api/custom-agents/"+id, key, nil); code != http.StatusNotFound {
		t.Fatalf("delete again = %d", code)
	}
	// 运行中拒绝删除。
	code, env = postAgent(t, ts, key, map[string]any{"name": "忙碌"})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	busy := env["data"].(map[string]any)["id"].(string)
	s.state.mu.Lock()
	s.state.jobs["job-busy"] = &chatJob{ID: "job-busy", Workspace: busy}
	s.state.mu.Unlock()
	if code, env := call(t, ts, "DELETE", "/api/custom-agents/"+busy, key, nil); code != http.StatusConflict {
		t.Fatalf("delete running = %d %v", code, env)
	}
	s.state.mu.Lock()
	delete(s.state.jobs, "job-busy")
	s.state.mu.Unlock()
	if code, _ := call(t, ts, "DELETE", "/api/custom-agents/"+busy, key, nil); code != http.StatusOK {
		t.Fatalf("delete idle = %d", code)
	}
	// 智能体不出现在项目列表。
	code, env = postAgent(t, ts, key, map[string]any{"name": "隐身"})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	hidden := env["data"].(map[string]any)["id"].(string)
	_, env = call(t, ts, "GET", "/api/workspaces", key, nil)
	for _, item := range env["data"].([]any) {
		if item.(map[string]any)["hash"] == hidden {
			t.Fatal("agent leaked into /api/workspaces")
		}
	}
}

func TestCustomAgentCatalogShape(t *testing.T) {
	ts, key, _, _ := parityServer(t, "")
	code, env := call(t, ts, "GET", "/api/custom-agents/catalog", key, nil)
	if code != http.StatusOK {
		t.Fatalf("catalog = %d %v", code, env)
	}
	data := env["data"].(map[string]any)
	chatNames := map[string]bool{}
	for _, item := range data["chatTools"].([]any) {
		entry := item.(map[string]any)
		if _, ok := entry["readOnly"]; !ok {
			t.Fatalf("entry = %v", entry)
		}
		chatNames[entry["name"].(string)] = true
	}
	projectNames := map[string]bool{}
	for _, item := range data["projectTools"].([]any) {
		projectNames[item.(map[string]any)["name"].(string)] = true
	}
	if !chatNames[shellenv.Current.Name] || !chatNames["skillread"] || chatNames["read"] {
		t.Fatalf("chatTools = %v", chatNames)
	}
	if !projectNames["read"] || !projectNames["write"] {
		t.Fatalf("projectTools = %v", projectNames)
	}
	for _, item := range data["skills"].([]any) {
		entry := item.(map[string]any)
		if entry["scope"] == nil || entry["name"] == nil {
			t.Fatalf("skill = %v", entry)
		}
	}
}

func TestUnboundAgentRunsLikePureChat(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	dir := filepath.Join(home, "skills", "chat-helper")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: chat-helper\ndescription: chat skill\n---\nBODY"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, env := postAgent(t, ts, key, map[string]any{"name": "闲谈", "instruction": "用中文闲聊"})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	view, err := s.projectRuntime(id)
	if err != nil {
		t.Fatal(err)
	}
	if !view.chatScoped() || !view.registry.ChatScope() {
		t.Fatal("unbound agent should be chat scoped")
	}
	text := view.agent.Instruction()
	if !strings.Contains(text, "纯聊天") || !strings.Contains(text, "「闲谈」") || !strings.Contains(text, "用中文闲聊") {
		t.Fatalf("instruction = %s", text)
	}
	names := toolNames(view.registry)
	if !names["skillread"] || names["read"] || names["sub_agent"] {
		t.Fatalf("tools = %v", names)
	}
	if resolved, err := s.resolveProject(id); err != nil || filepath.Clean(resolved) != filepath.Clean(filepath.Join(home, "chat-workspace")) {
		t.Fatalf("resolve = %v %v", resolved, err)
	}
	if _, err := s.projectRuntime("agent_0123456789ab"); err == nil || !strings.Contains(err.Error(), "智能体不存在") {
		t.Fatalf("unknown agent = %v", err)
	}
	if !validWorkspaceRef(id) {
		t.Fatal("workspaceRef rejected agent id")
	}
}

func TestBoundAgentRunsLikeProject(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	// 绑定到一个非根的已注册项目，根项目永远可解析，无法覆盖“项目消失”分支。
	workspace := filepath.Join(home, "bound-project")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	projectHash := service.WorkspaceHash(workspace)
	if err := s.registerProject(projectHash, workspace); err != nil {
		t.Fatal(err)
	}
	code, env := postAgent(t, ts, key, map[string]any{
		"name": "项目助手", "instruction": "只回答本项目问题", "projectHash": projectHash,
	})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	view, err := s.projectRuntime(id)
	if err != nil {
		t.Fatal(err)
	}
	if view.chatScoped() || view.registry.ChatScope() {
		t.Fatal("bound agent should not be chat scoped")
	}
	if filepath.Clean(view.workspaceRoot()) != filepath.Clean(workspace) {
		t.Fatalf("root = %v", view.workspaceRoot())
	}
	text := view.agent.Instruction()
	if !strings.Contains(text, "「项目助手」") || !strings.Contains(text, "只回答本项目问题") {
		t.Fatalf("instruction = %s", text)
	}
	names := toolNames(view.registry)
	if !names["read"] || !names["write"] || !names["sub_agent"] {
		t.Fatalf("tools = %v", names)
	}
	if resolved, err := s.resolveProject(id); err != nil || filepath.Clean(resolved) != filepath.Clean(workspace) {
		t.Fatalf("resolve = %v %v", resolved, err)
	}
	// 绑定项目消失后明确报错。
	if err := os.RemoveAll(filepath.Join(home, "workspace", projectHash)); err != nil {
		t.Fatal(err)
	}
	s.state.mu.Lock()
	delete(s.state.runtimes, id)
	s.state.mu.Unlock()
	if _, err := s.projectRuntime(id); err == nil || !strings.Contains(err.Error(), "绑定的项目不存在") {
		t.Fatalf("gone project = %v", err)
	}
}

func TestAgentToolAllowlistSurvivesRebuild(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	code, env := postAgent(t, ts, key, map[string]any{
		"name": "只读", "projectHash": s.agent.App(), "tools": []string{"read", "skillread"},
	})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	view, err := s.projectRuntime(id)
	if err != nil {
		t.Fatal(err)
	}
	assertAllowed := func(reg *tools.Registry) {
		t.Helper()
		// Tools(nil) 需要无审批策略，否则门禁会访问上下文。
		reg.SetPolicy(nil)
		for _, entry := range reg.List() {
			name := entry["name"].(string)
			enabled := entry["enabled"].(bool)
			if (name == "read" || name == "skillread") != enabled {
				t.Fatalf("%s enabled=%v", name, enabled)
			}
		}
		exposed, err := reg.Tools(nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, tl := range exposed {
			if tl.Name() != "read" && tl.Name() != "skillread" {
				t.Fatalf("exposed %s", tl.Name())
			}
		}
	}
	assertAllowed(view.registry)
	// Configure 不重置允许清单。
	view.registry.Configure(nil, nil, nil)
	assertAllowed(view.registry)
	// 轮次重建注册表后由 applyToolConfig 重新应用。
	rebuilt := tools.NewRegistry(view.registry.Entries()...)
	turn := *view
	turn.registry = rebuilt
	turn.applyToolConfig()
	assertAllowed(rebuilt)
}

func TestAgentSkillAllowlist(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	for _, name := range []string{"one", "two"} {
		dir := filepath.Join(home, "skills", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := fmt.Sprintf("---\nname: %s\ndescription: %s\n---\nBODY-%s", name, name, strings.ToUpper(name))
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	code, env := postAgent(t, ts, key, map[string]any{
		"name": "限技", "skills": []string{"@loopra-skills/one"},
	})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	view, err := s.projectRuntime(id)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range view.availableSkillMetadata() {
		if entry["scope"] != "@loopra-skills/one" {
			t.Fatalf("listed = %v", entry["scope"])
		}
	}
	if !strings.Contains(view.agent.Instruction(), "@loopra-skills/one") || strings.Contains(view.agent.Instruction(), "@loopra-skills/two") {
		t.Fatalf("instruction skills not filtered")
	}
	// 工具内部错误以 FunctionResponse 返回而不是 Go error。
	result, err := view.callExportTool(context.Background(), "skillread", map[string]any{"name": "@loopra-skills/two"})
	if err == nil && !strings.Contains(fmt.Sprint(result), "不在当前智能体的可用范围") {
		t.Fatalf("skillread should reject disallowed skill: %v", result)
	}
	result, err = view.callExportTool(context.Background(), "skillread", map[string]any{"name": "@loopra-skills/one"})
	if err != nil || !strings.Contains(fmt.Sprint(result), "BODY-ONE") {
		t.Fatalf("skillread = %v %v", result, err)
	}
}

// 项目工作区里单个会话绑定自定义智能体角色：角色只作用于该会话的
// 轮次派生，工作区仍是项目域（文件工具、sub_agent、非聊天指令）。
func TestSessionBoundAgentInProject(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	project := s.agent.App()
	code, env := postAgent(t, ts, key, map[string]any{
		"name": "评审员", "instruction": "只做代码评审", "tools": []string{"read", "skillread"},
	})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	code, env = postAgent(t, ts, key, map[string]any{"name": "第二个", "instruction": "备用"})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	other := env["data"].(map[string]any)["id"].(string)

	// 未知角色、格式非法的 id 与非内置引擎都在 prepare 阶段被拒。
	for _, body := range []map[string]any{
		{"workspaceHash": project, "sessionName": "bad", "agentId": "native", "customAgentId": "agent_0123456789ab"},
		{"workspaceHash": project, "sessionName": "bad", "agentId": "native", "customAgentId": "nope"},
		{"workspaceHash": project, "sessionName": "bad", "agentId": "codex", "customAgentId": id},
	} {
		if code, env := call(t, ts, "POST", "/api/agent-engines/prepare", key, body); code != http.StatusBadRequest {
			t.Fatalf("prepare %v = %d %v", body, code, env)
		}
	}
	// 正常绑定并回显。
	code, env = call(t, ts, "POST", "/api/agent-engines/prepare", key, map[string]any{
		"workspaceHash": project, "sessionName": "persona-one", "agentId": "native", "customAgentId": id,
	})
	if code != http.StatusOK {
		t.Fatalf("prepare = %d %v", code, env)
	}
	data := env["data"].(map[string]any)
	if data["customAgentId"] != id || data["agentId"] != "native" {
		t.Fatalf("prepare data = %v", data)
	}
	if got := strOr(s.sessionMetaRead("persona-one"), "customAgentId", ""); got != id {
		t.Fatalf("meta = %q", got)
	}
	// 写入一条历史，让绑定冲突分支可被命中。
	created, err := s.agent.Sessions.Create(context.Background(), createReq(s.agent, "persona-one"))
	if err != nil {
		t.Fatal(err)
	}
	if err := appendTextEvent(t, s.agent, created.Session, "seed"); err != nil {
		t.Fatal(err)
	}
	// 会话列表透出绑定。
	code, env = call(t, ts, "GET", "/api/sessions?workspaceHash="+project, key, nil)
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, env)
	}
	found := false
	for _, item := range env["data"].([]any) {
		row := item.(map[string]any)
		if row["name"] == "persona-one" {
			found = row["customAgentId"] == id
		}
	}
	if !found {
		t.Fatalf("session row missing customAgentId: %v", env["data"])
	}
	// 轮次派生带上角色块与工具白名单，但保持项目上下文。
	turn, err := s.prepareTurn(&chatRequest{SessionName: "persona-one"})
	if err != nil {
		t.Fatal(err)
	}
	if turn.chatScoped() {
		t.Fatal("persona session must stay project scoped")
	}
	text := turn.agent.Instruction()
	if !strings.Contains(text, "「评审员」") || !strings.Contains(text, "只做代码评审") {
		t.Fatalf("instruction = %s", text)
	}
	turn.registry.SetPolicy(nil)
	exposed, err := turn.registry.Tools(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tl := range exposed {
		if tl.Name() != "read" && tl.Name() != "skillread" {
			t.Fatalf("exposed %s", tl.Name())
		}
	}
	// 空会话可以改绑；有内容的会话拒绝换绑。
	code, env = call(t, ts, "POST", "/api/agent-engines/prepare", key, map[string]any{
		"workspaceHash": project, "sessionName": "persona-empty", "agentId": "native", "customAgentId": id,
	})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	code, _ = call(t, ts, "POST", "/api/agent-engines/prepare", key, map[string]any{
		"workspaceHash": project, "sessionName": "persona-empty", "agentId": "native", "customAgentId": other,
	})
	if code != http.StatusOK {
		t.Fatalf("rebind empty = %d", code)
	}
	if got := strOr(s.sessionMetaRead("persona-empty"), "customAgentId", ""); got != other {
		t.Fatalf("rebind meta = %q", got)
	}
	code, _ = call(t, ts, "POST", "/api/agent-engines/prepare", key, map[string]any{
		"workspaceHash": project, "sessionName": "persona-one", "agentId": "native", "customAgentId": other,
	})
	if code != http.StatusConflict {
		t.Fatalf("rebind populated = %d", code)
	}
	// 聊天入口同样拦截换绑与外部引擎组合。
	code, _ = call(t, ts, "POST", "/api/chat/stream", key, map[string]any{
		"workspaceHash": project, "sessionName": "persona-one", "message": "hi",
		"agentId": "native", "customAgentId": other,
	})
	if code != http.StatusConflict {
		t.Fatalf("chat rebind = %d", code)
	}
	code, _ = call(t, ts, "POST", "/api/chat/stream", key, map[string]any{
		"workspaceHash": project, "sessionName": "fresh", "message": "hi",
		"agentId": "codex", "customAgentId": id,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("chat external+persona = %d", code)
	}
	// 分支继承绑定。
	code, env = call(t, ts, "POST", "/api/sessions/persona-one/branch?messageCount=1", key, nil)
	if code != http.StatusOK {
		t.Fatalf("branch = %d %v", code, env)
	}
	branched := env["data"].(map[string]any)["sessionName"].(string)
	if got := strOr(s.sessionMetaRead(branched), "customAgentId", ""); got != id {
		t.Fatalf("branch meta = %q", got)
	}
}

// 未绑定但已有内容的会话同样拒绝首次绑定（409 且不落 .meta）；
// 纯聊天工作区不接受 customAgentId（400）。
func TestSessionBindRejectsPopulatedAndChat(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	project := s.agent.App()
	code, env := postAgent(t, ts, key, map[string]any{"name": "评审员", "instruction": "只做代码评审"})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	id := env["data"].(map[string]any)["id"].(string)

	// 造一条没有绑定、但已有消息的会话。
	created, err := s.agent.Sessions.Create(context.Background(), createReq(s.agent, "populated"))
	if err != nil {
		t.Fatal(err)
	}
	if err := appendTextEvent(t, s.agent, created.Session, "seed"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/agent-engines/prepare", "/api/chat/stream"} {
		body := map[string]any{
			"workspaceHash": project, "sessionName": "populated", "agentId": "native", "customAgentId": id,
		}
		if path == "/api/chat/stream" {
			body["message"] = "hi"
		}
		if code, env := call(t, ts, "POST", path, key, body); code != http.StatusConflict {
			t.Fatalf("%s bind populated = %d %v", path, code, env)
		}
	}
	if got := strOr(s.sessionMetaRead("populated"), "customAgentId", ""); got != "" {
		t.Fatalf("meta must stay unbound, got %q", got)
	}
	// 纯聊天工作区：prepare 与 chat/stream 都返回 400。
	for _, path := range []string{"/api/agent-engines/prepare", "/api/chat/stream"} {
		body := map[string]any{
			"workspaceHash": chatWorkspace, "sessionName": "chat-persona", "agentId": "native", "customAgentId": id,
		}
		if path == "/api/chat/stream" {
			body["message"] = "hi"
		}
		if code, env := call(t, ts, "POST", path, key, body); code != http.StatusBadRequest {
			t.Fatalf("%s chat workspace = %d %v", path, code, env)
		}
	}
}

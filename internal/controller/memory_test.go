package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/model"
)

func TestMemoryReadMethods(t *testing.T) {
	ts, key, _, _ := parityServer(t, "")
	for _, method := range []string{http.MethodHead, http.MethodPatch} {
		request, err := http.NewRequest(method, ts.URL+"/api/memories?scope=global", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Loopra-Key", key)
		response, err := ts.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("response read/close = %v / %v", readErr, closeErr)
		}
		if method == http.MethodHead && (response.StatusCode != http.StatusOK || len(body) != 0) {
			t.Fatalf("HEAD = %d %q", response.StatusCode, body)
		}
		if method == http.MethodPatch && (response.StatusCode != http.StatusMethodNotAllowed || !strings.Contains(response.Header.Get("Allow"), "HEAD")) {
			t.Fatalf("PATCH = %d Allow: %s", response.StatusCode, response.Header.Get("Allow"))
		}
	}
}

func TestProjectMemoryUsesMainProjectDirectoryInWorktree(t *testing.T) {
	_, _, s, _ := parityServer(t, "")
	entry, err := s.memories.Save(s.agent.App(), model.Memory{Title: "主项目约定", Content: "MAIN PROJECT MEMORY", Kind: "fact"}, "user")
	if err != nil {
		t.Fatal(err)
	}
	view := *s
	view.cfg = s.cfg.Clone()
	view.cfg.WorkspaceDir = t.TempDir()
	entries, err := view.memories.List(view.agent.App(), "MAIN PROJECT MEMORY")
	if err != nil || len(entries) != 1 || entries[0].ID != entry.ID {
		t.Fatalf("worktree memory = %v %v", entries, err)
	}
	entry.Content = "UPDATED FROM WORKTREE"
	if _, err := view.memories.Save(view.agent.App(), entry, "agent"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(s.workspaceRoot(), ".loopra", "memory", "memories.json"))
	if err != nil || !strings.Contains(string(data), "UPDATED FROM WORKTREE") {
		t.Fatalf("main project update = %s %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(view.workspaceRoot(), ".loopra", "memory", "memories.json")); !os.IsNotExist(err) {
		t.Fatalf("worktree created a separate memory file: %v", err)
	}
}

func TestMemoryAPIAndPromptStability(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	global := "/api/memories?scope=global"
	status, env := call(t, ts, "POST", global, key, map[string]any{"title": "个人偏好", "content": "GLOBAL PREFERENCE", "kind": "preference"})
	if status != 200 || env["success"] != true {
		t.Fatalf("create = %d %v", status, env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	project := "/api/memories?scope=project&workspaceHash=" + s.agent.App()
	status, env = call(t, ts, "POST", project, key, map[string]any{"title": "项目约定", "content": "PROJECT CONVENTION", "kind": "fact"})
	if status != 200 {
		t.Fatalf("project create = %d %v", status, env)
	}
	turn, err := s.prepareTurn(&chatRequest{SessionName: "memory-session"})
	if err != nil {
		t.Fatal(err)
	}
	prompt := turn.agent.Instruction()
	if strings.Contains(prompt, "GLOBAL PREFERENCE") || strings.Contains(prompt, "PROJECT CONVENTION") || !strings.Contains(prompt, "memory_search") {
		t.Fatalf("prompt should contain only memory guidance: %s", prompt)
	}
	result, err := turn.callExportTool(context.Background(), "memory_search", map[string]any{})
	if err != nil || !strings.Contains(fmt.Sprint(result), "个人偏好") || !strings.Contains(fmt.Sprint(result), "项目约定") || strings.Contains(fmt.Sprint(result), "GLOBAL PREFERENCE") || strings.Contains(fmt.Sprint(result), "PROJECT CONVENTION") {
		t.Fatalf("catalog should contain titles only = %v %v", result, err)
	}
	result, err = turn.callExportTool(context.Background(), "memory_search", map[string]any{"action": "read", "scope": "global", "id": id})
	if err != nil || !strings.Contains(fmt.Sprint(result), "GLOBAL PREFERENCE") {
		t.Fatalf("on-demand read = %v %v", result, err)
	}
	chat, err := s.projectRuntime(chatWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	result, err = chat.callExportTool(context.Background(), "memory_search", map[string]any{})
	if err != nil || !strings.Contains(fmt.Sprint(result), "个人偏好") || strings.Contains(fmt.Sprint(result), "项目约定") || strings.Contains(fmt.Sprint(result), "GLOBAL PREFERENCE") {
		t.Fatalf("chat memory scope = %v %v", result, err)
	}
	status, env = call(t, ts, "PUT", "/api/memories/"+id+"?scope=global", key, map[string]any{"title": "个人偏好", "content": "UPDATED GLOBAL", "kind": "preference", "revision": 1})
	if status != 200 {
		t.Fatalf("update = %d %v", status, env)
	}
	next, err := turn.prepareTurn(&chatRequest{SessionName: "memory-session"})
	if err != nil {
		t.Fatal(err)
	}
	if next.agent.Instruction() != prompt {
		t.Fatal("memory update changed the system prompt")
	}
	result, err = next.callExportTool(context.Background(), "memory_search", map[string]any{"action": "read", "scope": "global", "id": id})
	if err != nil || !strings.Contains(fmt.Sprint(result), "UPDATED GLOBAL") || strings.Contains(fmt.Sprint(result), "GLOBAL PREFERENCE") {
		t.Fatalf("updated on-demand read = %v %v", result, err)
	}
	status, env = call(t, ts, "DELETE", "/api/memories/"+id+"?scope=global&revision=1", key, nil)
	if status != http.StatusConflict || env["reason"] != "memory_conflict" {
		t.Fatalf("stale delete = %d %v", status, env)
	}
	status, env = call(t, ts, "DELETE", "/api/memories/"+id+"?scope=global&revision=2", key, nil)
	if status != 200 {
		t.Fatalf("delete = %d %v", status, env)
	}
	status, env = call(t, ts, "GET", global, key, nil)
	if status != 200 || len(env["data"].([]any)) != 0 {
		t.Fatalf("list after delete = %d %v", status, env)
	}
}

func TestMemoryScopesErrorsAndToolAccess(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	for _, query := range []string{"", "?scope=unknown", "?scope=project", "?scope=project&workspaceHash=__loopra_chat__", "?scope=project&workspaceHash=missing", "?scope=project&workspaceHash=.."} {
		status, env := call(t, ts, "GET", "/api/memories"+query, key, nil)
		if status != 400 || env["reason"] != "invalid_memory" {
			t.Fatalf("scope %s = %d %v", query, status, env)
		}
	}
	if status, _ := call(t, ts, "GET", "/api/memories?scope=global", "", nil); status != 401 {
		t.Fatalf("unauthenticated status = %d", status)
	}
	other, err := s.projectRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.memories.Save(other.agent.App(), model.Memory{Title: "other", Content: "OTHER PROJECT", Kind: "fact"}, "user"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.memories.Save(s.agent.App(), model.Memory{Title: "current", Content: "CURRENT PROJECT", Kind: "fact"}, "user"); err != nil {
		t.Fatal(err)
	}
	result, err := s.callExportTool(context.Background(), "memory_search", map[string]any{"action": "search", "query": "CURRENT PROJECT"})
	if err != nil || !strings.Contains(fmt.Sprint(result), "CURRENT PROJECT") || strings.Contains(fmt.Sprint(result), "OTHER PROJECT") {
		t.Fatalf("search = %v %v", result, err)
	}
	chat, err := s.projectRuntime(chatWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	result, err = chat.callExportTool(context.Background(), "memory", map[string]any{"action": "save", "scope": "project", "title": "x", "content": "x", "kind": "fact"})
	if err == nil && !strings.Contains(fmt.Sprint(result), "请选择") {
		t.Fatalf("chat wrote project memory = %v %v", result, err)
	}
	result, err = chat.callExportTool(context.Background(), "memory", map[string]any{"action": "save", "scope": "global", "title": "Node runtime", "content": "Use nvm", "kind": "environment"})
	if err != nil || !strings.Contains(fmt.Sprint(result), "Use nvm") {
		t.Fatalf("tool save = %v %v", result, err)
	}
	entries, err := s.memories.List("", "nvm")
	if err != nil || len(entries) != 1 || entries[0].Source != "agent" {
		t.Fatalf("tool persistence = %v %v", entries, err)
	}
	if err := os.WriteFile(filepath.Join(home, "memories.json"), []byte(`broken`), 0o600); err != nil {
		t.Fatal(err)
	}
	status, env := call(t, ts, "GET", "/api/memories?scope=global", key, nil)
	if status != 500 || env["reason"] != "memory_storage_failed" {
		t.Fatalf("corrupt API = %d %v", status, env)
	}
	if _, err := s.prepareTurn(&chatRequest{SessionName: "corrupt"}); err != nil {
		t.Fatalf("unused memory should not block a normal turn: %v", err)
	}
	result, err = s.callExportTool(context.Background(), "memory_search", map[string]any{"scope": "global"})
	if err == nil && !strings.Contains(fmt.Sprint(result), "读取记忆失败") {
		t.Fatalf("corrupt memory search hid the failure: %v", result)
	}
	// 项目记忆位于注册的主项目目录，隔离工作树不会建立另一个记忆作用域。
	var data map[string]any
	raw, err := os.ReadFile(filepath.Join(s.workspaceRoot(), ".loopra", "memory", "memories.json"))
	if err != nil || json.Unmarshal(raw, &data) != nil {
		t.Fatalf("project file = %s %v", raw, err)
	}
}

func TestMemoryCatalogReadSearchAndPagination(t *testing.T) {
	_, _, s, _ := parityServer(t, "")
	var globals []model.Memory
	for i := range 15 {
		entry, err := s.memories.Save("", model.Memory{Title: fmt.Sprintf("Global topic %02d", i), Content: fmt.Sprintf("BODY_ONLY_GLOBAL_%02d", i), Kind: "fact"}, "user")
		if err != nil {
			t.Fatal(err)
		}
		globals = append(globals, entry)
	}
	project, err := s.memories.Save(s.agent.App(), model.Memory{Title: "Project topic", Content: "PROJECT_BODY", Kind: "fact"}, "user")
	if err != nil {
		t.Fatal(err)
	}
	type page struct {
		Entries []map[string]json.RawMessage `json:"entries"`
		Total   int                          `json:"total"`
		Offset  int                          `json:"offset"`
	}
	decode := func(result map[string]any, scope string) page {
		t.Helper()
		data, err := json.Marshal(result[scope])
		if err != nil {
			t.Fatal(err)
		}
		var out page
		if err := json.Unmarshal(data, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	result, err := s.callExportTool(context.Background(), "memory_search", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	first := decode(result, "global")
	if first.Total != 15 || first.Offset != 0 || len(first.Entries) != 10 || decode(result, "project").Total != 1 {
		t.Fatalf("first catalog page = %+v %v", first, result)
	}
	seen := map[string]bool{}
	checkIndex := func(entries []map[string]json.RawMessage) {
		t.Helper()
		for _, entry := range entries {
			if len(entry) != 2 || entry["id"] == nil || entry["title"] == nil {
				t.Fatalf("catalog leaked non-index fields = %v", entry)
			}
			id := string(entry["id"])
			if seen[id] {
				t.Fatalf("repeated catalog item = %s", id)
			}
			seen[id] = true
		}
	}
	checkIndex(first.Entries)
	result, err = s.callExportTool(context.Background(), "memory_search", map[string]any{"action": "list", "scope": "global", "offset": 10})
	if err != nil {
		t.Fatal(err)
	}
	second := decode(result, "global")
	if second.Total != 15 || second.Offset != 10 || len(second.Entries) != 5 {
		t.Fatalf("next page = %+v", second)
	}
	if _, exists := result["project"]; exists {
		t.Fatal("explicit global catalog included project data")
	}
	checkIndex(second.Entries)
	if len(seen) != len(globals) {
		t.Fatalf("catalog lost entries = %d", len(seen))
	}
	result, err = s.callExportTool(context.Background(), "memory_search", map[string]any{"action": "list", "scope": "global", "offset": 999})
	if err != nil {
		t.Fatal(err)
	}
	if empty := decode(result, "global"); empty.Total != 15 || len(empty.Entries) != 0 {
		t.Fatalf("end of catalog = %+v", empty)
	}
	result, err = s.callExportTool(context.Background(), "memory_search", map[string]any{"action": "read", "scope": "global", "id": globals[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result["entry"])
	if err != nil {
		t.Fatal(err)
	}
	var read model.Memory
	if err := json.Unmarshal(data, &read); err != nil {
		t.Fatal(err)
	}
	if read != globals[0] || result["scope"] != "global" {
		t.Fatalf("selected read = %+v %v", read, result)
	}
	// 兼容已有 query 调用，同时支持显式 search；都只在当前授权作用域检索。
	for _, args := range []map[string]any{{"query": "BODY_ONLY_GLOBAL_03", "scope": "global"}, {"action": "search", "query": "BODY_ONLY_GLOBAL_03", "scope": "global"}} {
		result, err = s.callExportTool(context.Background(), "memory_search", args)
		if err != nil {
			t.Fatal(err)
		}
		matches := decode(result, "global")
		if matches.Total != 1 || len(matches.Entries) != 1 || matches.Entries[0]["content"] == nil {
			t.Fatalf("search did not return matching body = %+v", matches)
		}
	}
	updated := globals[0]
	updated.Title = "Renamed Node.js tooling"
	if _, err := s.memories.Save("", updated, "user"); err != nil {
		t.Fatal(err)
	}
	result, err = s.callExportTool(context.Background(), "memory_search", map[string]any{"action": "list", "scope": "global", "limit": 20})
	if err != nil || !strings.Contains(fmt.Sprint(result), updated.Title) || strings.Contains(fmt.Sprint(result), globals[0].Title) {
		t.Fatalf("catalog did not reflect renamed memory = %v %v", result, err)
	}
	if err := s.memories.Delete(s.agent.App(), project.ID, project.Revision); err != nil {
		t.Fatal(err)
	}
	result, err = s.callExportTool(context.Background(), "memory_search", map[string]any{"action": "list", "scope": "project"})
	if err != nil {
		t.Fatal(err)
	}
	if remaining := decode(result, "project"); remaining.Total != 0 || len(remaining.Entries) != 0 {
		t.Fatalf("catalog kept deleted memory = %+v", remaining)
	}
	for _, args := range []map[string]any{
		{"action": "read", "id": globals[0].ID},
		{"action": "read", "scope": "global", "id": project.ID},
		{"action": "read", "scope": "project", "id": globals[0].ID},
		{"action": "read", "scope": "global", "id": "missing"},
		{"action": "search"},
		{"action": "unknown"},
		{"action": "list", "offset": -1},
		{"action": "list", "limit": 21},
	} {
		result, err := s.callExportTool(context.Background(), "memory_search", args)
		if err == nil && result["error"] == nil {
			t.Fatalf("invalid/out-of-scope request succeeded: %v = %v", args, result)
		}
	}
}

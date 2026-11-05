package controller

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	"github.com/ezdemo/looprax/internal/service/projectlinks"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestLinkedDirectoryDoesNotRegisterProjectAndAppliesToTurns(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	main, root, configured := s.agent.App(), s.workspaceRoot(), s.configSnapshot().WorkspaceDir
	path := filepath.Join(home, "新副项目")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	initialProjects := len(s.projectList())
	code, env := call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{
		"linkedProjectPaths": []string{path, path + string(filepath.Separator) + "."},
	})
	if code != http.StatusOK {
		t.Fatalf("link directory = %d %v", code, env)
	}
	if len(s.projectList()) != initialProjects {
		t.Fatal("linking a directory created a project in the list")
	}
	if _, err := os.Stat(filepath.Join(home, "workspace", service.WorkspaceHash(path))); !os.IsNotExist(err) {
		t.Fatalf("directory link created project data: %v", err)
	}
	if s.agent.App() != main || s.workspaceRoot() != root || s.configSnapshot().WorkspaceDir != configured {
		t.Fatal("linking a directory switched the workspace")
	}
	meta := repository.ReadObject(filepath.Join(home, "workspace", main, "workspace.json"))
	if !reflect.DeepEqual(projectlinks.Paths(meta), []string{path}) || len(projectlinks.Hashes(meta)) != 0 {
		t.Fatalf("saved directory links = %v", meta)
	}
	// 旧客户端只更新项目标识时，保留新版本保存的目录关联。
	code, env = call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectHashes": []string{}})
	if code != http.StatusOK {
		t.Fatalf("legacy save = %d %v", code, env)
	}
	if err := s.saveConfig(map[string]any{"toolsRestrictWorkspace": true, "hitl": "approval"}); err != nil {
		t.Fatal(err)
	}
	view, err := s.projectRuntime(main)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := view.prepareTurn(&chatRequest{SessionName: "directory"})
	if err != nil || !reflect.DeepEqual(turn.linkedProjectRoots, []string{path}) {
		t.Fatalf("directory turn = %v %v", turn, err)
	}
	if !strings.Contains(turn.agent.Instruction(), path) || !strings.Contains(turn.subRunner.Environment, path) {
		t.Fatal("directory omitted from agent environment")
	}
	acpRoots, err := view.resolveLinkedProjects(&chatRequest{})
	if err != nil || !reflect.DeepEqual(acpRoots, []string{path}) {
		t.Fatalf("ACP directory roots = %v %v", acpRoots, err)
	}
	turn, err = view.prepareTurn(&chatRequest{SessionName: "directory-write"})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(path, "allowed.txt")
	if _, err := turn.callExportTool(tools.WithLinkedProjects(context.Background(), turn.linkedProjectRoots), "write", map[string]any{"path": target, "content": "directory content"}); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "directory content" {
		t.Fatalf("linked directory write = %q %v", data, err)
	}
	code, env = call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectPaths": []string{}})
	if code != http.StatusOK {
		t.Fatalf("unlink directory = %d %v", code, env)
	}
	next, err := view.prepareTurn(&chatRequest{SessionName: "directory-write"})
	if err != nil || len(next.linkedProjectRoots) != 0 {
		t.Fatalf("directory permission not revoked: %v %v", next, err)
	}
	next.callExportTool(tools.WithLinkedProjects(context.Background(), next.linkedProjectRoots), "write", map[string]any{"path": target, "content": "denied"})
	if data, _ := os.ReadFile(target); string(data) != "directory content" {
		t.Fatal("unlinked directory was modified")
	}
	if !reflect.DeepEqual(turn.linkedProjectRoots, []string{path}) {
		t.Fatal("unlinking changed the earlier turn's directory snapshot")
	}
}

func TestProjectLinksPersistAndUpdateCachedRuntime(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	main := s.agent.App()
	linkedPath := filepath.Join(home, "linked")
	linked := addProject(t, ts, key, linkedPath)
	otherPath := filepath.Join(home, "other")
	other := addProject(t, ts, key, otherPath)
	view, err := s.projectRuntime(main)
	if err != nil {
		t.Fatal(err)
	}
	code, env := call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{
		"linkedProjectHashes": []string{main, linked, linked},
	})
	if code != http.StatusOK {
		t.Fatalf("save = %d %v", code, env)
	}
	meta := repository.ReadObject(filepath.Join(home, "workspace", main, "workspace.json"))
	if !reflect.DeepEqual(projectlinks.Hashes(meta), []string{linked}) || meta["path"] != s.workspaceRoot() {
		t.Fatalf("saved metadata = %v", meta)
	}
	turn, err := view.prepareTurn(&chatRequest{SessionName: "linked", LinkedProjectHashes: []string{linked, other}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(turn.linkedProjectRoots, []string{linkedPath, otherPath}) {
		t.Fatalf("roots = %v", turn.linkedProjectRoots)
	}
	for _, text := range []string{turn.agent.Instruction(), turn.subRunner.Environment} {
		for _, want := range []string{linkedPath, otherPath, "相对路径与默认命令工作目录均以主项目为准"} {
			if !strings.Contains(text, want) {
				t.Fatalf("missing %q in system environment: %s", want, text)
			}
		}
	}
	if strings.Contains(turn.agent.Instruction(), "本轮关联项目") {
		t.Fatal("legacy per-project prompt blocks still present")
	}
	if s.memories != nil && !strings.Contains(turn.agent.Instruction(), memoryInstruction) {
		t.Fatal("linked workspace prompt lost the memory instructions")
	}
	if !strings.Contains(view.systemInstruction(view.workspaceRoot()), linkedPath) {
		t.Fatal("system prompt preview omitted the saved link")
	}
	acpRoots, err := view.resolveLinkedProjects(&chatRequest{LinkedProjectHashes: []string{other}})
	if err != nil || !reflect.DeepEqual(acpRoots, turn.linkedProjectRoots) {
		t.Fatalf("external roots = %v, %v", acpRoots, err)
	}
	code, env = call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectHashes": []string{}})
	if code != http.StatusOK {
		t.Fatalf("unlink = %d %v", code, env)
	}
	next, err := turn.prepareTurn(&chatRequest{SessionName: "linked"})
	if err != nil || len(next.linkedProjectRoots) != 0 {
		t.Fatalf("removed roots still active: %v, %v", next, err)
	}
	if strings.Contains(next.agent.Instruction(), linkedPath) || strings.Contains(next.agent.Instruction(), otherPath) {
		t.Fatal("removed or temporary links leaked into the next system prompt")
	}
}

func TestProjectLinksValidateBeforeSaving(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	main := s.agent.App()
	var hashes []string
	for i := range 9 {
		hashes = append(hashes, addProject(t, ts, key, filepath.Join(home, string(rune('a'+i)))))
	}
	for _, value := range []any{nil, []string{"missing"}, []string{".."}, []string{chatWorkspace}, []string{s.workspaceRoot()}, hashes} {
		code, env := call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectHashes": value})
		if code != http.StatusBadRequest {
			t.Fatalf("invalid links %v = %d %v", value, code, env)
		}
	}
	for _, hash := range []string{"missing", chatWorkspace} {
		code, _ := call(t, ts, http.MethodPut, "/api/workspaces/"+hash+"/links", key, map[string]any{"linkedProjectHashes": []string{}})
		if code != http.StatusBadRequest {
			t.Fatalf("invalid owner %s accepted", hash)
		}
	}
	meta := repository.ReadObject(filepath.Join(home, "workspace", main, "workspace.json"))
	if len(projectlinks.Hashes(meta)) != 0 {
		t.Fatal("rejected request partially saved links")
	}
}

func TestLinkedWorkspaceWritePermissionAndRevocation(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	main := s.agent.App()
	linkedPath := filepath.Join(home, "linked")
	linked := addProject(t, ts, key, linkedPath)
	outsidePath := filepath.Join(home, "outside")
	outside := addProject(t, ts, key, outsidePath)
	if err := s.saveConfig(map[string]any{"toolsRestrictWorkspace": true, "hitl": "approval"}); err != nil {
		t.Fatal(err)
	}
	call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectHashes": []string{linked}})
	view, err := s.projectRuntime(main)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := view.prepareTurn(&chatRequest{SessionName: "write"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := tools.WithLinkedProjects(context.Background(), turn.linkedProjectRoots)
	target := filepath.Join(linkedPath, "allowed.txt")
	if _, err := turn.callExportTool(ctx, "write", map[string]any{"path": target, "content": "linked content"}); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "linked content" {
		t.Fatalf("linked write = %q, %v", data, err)
	}
	if _, err := turn.callExportTool(ctx, "edit", map[string]any{"path": target, "edits": []map[string]string{{"old": "linked content", "new": "updated content"}}}); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "updated content" {
		t.Fatalf("linked edit = %q, %v", data, err)
	}
	for _, path := range []string{filepath.Join(outsidePath, "denied.txt"), filepath.Join(linkedPath+"-sibling", "denied.txt")} {
		if !turn.approvalPolicy.Require("write", "write", map[string]any{"path": path}) {
			t.Fatalf("unlinked write automatically approved: %s", path)
		}
	}
	call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectHashes": []string{}})
	next, err := view.prepareTurn(&chatRequest{SessionName: "write"})
	if err != nil {
		t.Fatal(err)
	}
	if !next.approvalPolicy.Require("write", "write", map[string]any{"path": target}) {
		t.Fatal("revoked project still automatically approved")
	}
	// 工具错误也可能作为 FunctionResponse 返回；以文件未被修改验证边界。
	next.callExportTool(tools.WithLinkedProjects(context.Background(), next.linkedProjectRoots), "write", map[string]any{"path": target, "content": "denied"})
	if data, _ := os.ReadFile(target); string(data) != "updated content" {
		t.Fatal("revoked project was modified")
	}
	// A -> B -> C 只授权 B，不把 B 的权限隐式传递到 A。
	call(t, ts, http.MethodPut, "/api/workspaces/"+main+"/links", key, map[string]any{"linkedProjectHashes": []string{linked}})
	call(t, ts, http.MethodPut, "/api/workspaces/"+linked+"/links", key, map[string]any{"linkedProjectHashes": []string{outside}})
	roots, err := view.resolveLinkedProjects(&chatRequest{})
	if err != nil || !reflect.DeepEqual(roots, []string{linkedPath}) {
		t.Fatalf("transitive roots = %v %v", roots, err)
	}
	// 移除副项目记录后，缓存的主项目也不得继续获得该目录权限。
	call(t, ts, http.MethodDelete, "/api/workspaces/"+linked, key, nil)
	roots, err = view.resolveLinkedProjects(&chatRequest{})
	if err != nil || len(roots) != 0 {
		t.Fatalf("deleted roots = %v %v", roots, err)
	}
}

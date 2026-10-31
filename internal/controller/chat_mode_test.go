package controller

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestPureChatSupportsSkillsAndShellWithoutProjectContext(t *testing.T) {
	_, _, s, home := parityServer(t, "")
	if err := os.WriteFile(filepath.Join(home, "loopra.md"), []byte("PROJECT PERSONA"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "skills", "chat-helper")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: chat-helper\ndescription: chat skill\n---\nCHAT SKILL BODY"), 0o600); err != nil {
		t.Fatal(err)
	}
	view, err := s.projectRuntime(chatWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := view.prepareTurn(&chatRequest{SessionName: "chat", LinkedProjectHashes: []string{"other"}})
	if err != nil {
		t.Fatal(err)
	}
	text := turn.agent.Instruction()
	if !strings.Contains(text, "纯聊天") {
		t.Fatalf("chat prompt = %s", text)
	}
	for _, forbidden := range []string{"PROJECT PERSONA", "AGENTS.md", "不要执行命令", "不要加载技能"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("chat prompt contains %q: %s", forbidden, text)
		}
	}
	for _, wanted := range []string{"@loopra-skills/chat-helper", "系统临时目录", os.TempDir(), "禁止读取、列出、搜索", "技能目录", "工具审批"} {
		if !strings.Contains(text, wanted) {
			t.Fatalf("chat prompt missing %q: %s", wanted, text)
		}
	}
	if req := turn.linkedProjectRoots; len(req) != 0 {
		t.Fatalf("chat linked projects = %v", req)
	}
	names := map[string]bool{}
	for _, entry := range turn.registry.Entries() {
		names[entry.Meta.Name] = true
	}
	if !names["web"] || names["read"] || names["write"] || names["sub_agent"] || names["submit_plan"] {
		t.Fatalf("chat tools = %v", names)
	}
	for _, wanted := range []string{"skillread", "skilllist", "skillsearch", "skillrefresh", shellenv.Current.Name, shellenv.Current.Name + "_start", shellenv.Current.Name + "_wait", shellenv.Current.Name + "_stdin", shellenv.Current.Name + "_stop"} {
		if !names[wanted] {
			t.Fatalf("chat tools missing %s: %v", wanted, names)
		}
	}
	result, err := turn.callExportTool(context.Background(), "skillread", map[string]any{"name": "@loopra-skills/chat-helper"})
	if err != nil || !strings.Contains(fmt.Sprint(result), "CHAT SKILL BODY") {
		t.Fatalf("chat skillread = %v %v", result, err)
	}
	result, err = turn.callExportTool(context.Background(), shellenv.Current.Name, map[string]any{"command": "echo LOOPRA_CHAT_TEMP"})
	if err != nil || !strings.Contains(fmt.Sprint(result), "LOOPRA_CHAT_TEMP") {
		t.Fatalf("chat shell = %v %v", result, err)
	}
	if filepath.Clean(fmt.Sprint(result["cwd"])) != filepath.Clean(os.TempDir()) {
		t.Fatalf("chat command cwd = %v", result["cwd"])
	}
	project, err := s.prepareTurn(&chatRequest{SessionName: "project"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(project.agent.Instruction(), "Working directory") || !strings.Contains(project.agent.Instruction(), "PROJECT PERSONA") {
		t.Fatalf("project prompt = %s", project.agent.Instruction())
	}
	foundRead := false
	for _, entry := range project.registry.Entries() {
		if entry.Meta.Name == "read" {
			foundRead = true
		}
	}
	if !foundRead {
		t.Fatal("project runtime lost file tools")
	}
	fresh, err := s.projectRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	foundSearch := false
	for _, entry := range fresh.registry.Entries() {
		if entry.Meta.Name == "web" {
			foundSearch = true
		}
	}
	if !foundSearch {
		t.Fatal("project agent is missing web")
	}
}

func TestPluginChatFlagFiltersChatMode(t *testing.T) {
	_, _, s, _ := parityServer(t, "")
	chat, err := s.projectRuntime(chatWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"side","version":"1.0.0","loopra":"./plugin.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	source := `export function tools() {
  return [
    { name: "note", description: "note", readOnly: true, chat: true },
    { name: "editx", description: "edit", readOnly: false }
  ];
}
export function call(input) { return { ok: input.name }; }
`
	if err := os.WriteFile(filepath.Join(dir, "plugin.js"), []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.plugins.Install(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	names := toolNames(chat.registry)
	if !names["web"] || !names["side__note"] || names["side__editx"] || names["read"] {
		t.Fatalf("chat tools = %v", names)
	}
	for _, entry := range chat.registry.Entries() {
		if entry.Meta.Name == "web" && !entry.Meta.Chat {
			t.Fatal("web is missing the chat declaration")
		}
	}
	project, err := s.projectRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	names = toolNames(project.registry)
	if !names["side__note"] || !names["side__editx"] || !names["read"] || !names["web"] {
		t.Fatalf("project tools = %v", names)
	}
}

func toolNames(reg *tools.Registry) map[string]bool {
	names := map[string]bool{}
	if reg == nil {
		return names
	}
	for _, entry := range reg.Entries() {
		names[entry.Meta.Name] = true
	}
	return names
}

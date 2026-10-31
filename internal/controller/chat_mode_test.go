package controller

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestPureChatUsesConversationPromptAndNoProjectTools(t *testing.T) {
	_, _, s, home := parityServer(t, "")
	if err := os.WriteFile(filepath.Join(home, "loopra.md"), []byte("PROJECT PERSONA"), 0o644); err != nil {
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
	for _, forbidden := range []string{"Working directory", "PROJECT PERSONA", "可用技能", "skillread", "AGENTS.md"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("chat prompt contains %q: %s", forbidden, text)
		}
	}
	names := map[string]bool{}
	for _, entry := range turn.registry.Entries() {
		names[entry.Meta.Name] = true
	}
	if !names["web"] || !names["search_apis"] || !names["get_api_detail"] || !names["call_api"] || names["read"] || names["skillread"] || len(names) != 4 {
		t.Fatalf("chat tools = %v", names)
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

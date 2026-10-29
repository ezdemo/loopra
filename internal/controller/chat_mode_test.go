package controller

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if !names["web"] || names["read"] || names["skillread"] || len(names) != 1 {
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

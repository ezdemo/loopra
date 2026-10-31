package controller

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillsMetadataAndReadingThroughRuntime(t *testing.T) {
	ts, key, s, home := parityServer(t, "")
	dir := filepath.Join(home, "skills", "fixture")
	os.MkdirAll(filepath.Join(dir, "references"), 0o755)
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: Fixture Skill\ndescription: >\n  Multiline skill\n  description.\n---\nFixture body."), 0o600)
	os.WriteFile(filepath.Join(dir, "references", "guide.txt"), []byte("fixture skill reference"), 0o600)
	_, env := call(t, ts, "GET", "/api/agent/skills", key, nil)
	entries := env["data"].([]any)
	if len(entries) != 2 {
		t.Fatalf("global skills = %v", entries)
	}
	found := false
	for _, entry := range entries {
		item := entry.(map[string]any)
		if len(item) != 5 {
			t.Fatalf("skill DTO exposed extra fields: %v", item)
		}
		if item["scope"] == "@loopra-skills/fixture" {
			found = item["description"] == "Multiline skill description."
		}
	}
	if !found {
		t.Fatal("YAML skill metadata not discovered")
	}
	for name, want := range map[string]string{"@builtin-skills/self-skill": "SelfSkill", "@loopra-skills/fixture": "Fixture body."} {
		result, err := s.callExportTool(context.Background(), "skillread", map[string]any{"name": name})
		if err != nil || !strings.Contains(fmt.Sprint(result), want) {
			t.Fatalf("skillread %s = %v %v", name, result, err)
		}
	}
	text, err := s.readSkill("@loopra-skills/fixture", "references/guide.txt")
	if err != nil || text != "fixture skill reference" {
		t.Fatalf("skill reference = %q %v", text, err)
	}
	_, err = s.readSkill("@loopra-skills/fixture", "references")
	if err == nil || !strings.Contains(err.Error(), "SKILL.md") || !strings.Contains(err.Error(), "references/guide.txt") || strings.Contains(err.Error(), "GetFileAttributesEx") {
		t.Fatalf("missing skill file = %v", err)
	}
	if _, err := s.readSkill("@loopra-skills/fixture", "../../config.json"); err == nil {
		t.Fatal("skill resource escaped its directory")
	}
	_, env = call(t, ts, "GET", "/api/tools/skillread", key, nil)
	params := env["data"].(map[string]any)["params"].([]any)
	found = false
	for _, entry := range params {
		item := entry.(map[string]any)
		if item["name"] == "name" && item["required"] == true {
			found = true
		}
		if item["name"] == "path" && !strings.Contains(fmt.Sprint(item["description"]), "SKILL.md") {
			t.Fatalf("path description = %v", item["description"])
		}
	}
	if !found {
		t.Fatalf("tool API omitted required parameter: %v", params)
	}
}

package acpserver

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/testutil"
)

func TestDefaultAgentsSkillsDiscoverAndReadLinkedMount(t *testing.T) {
	userHome, home, workspace := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("USERPROFILE", userHome)
	t.Setenv("HOME", userHome)
	t.Setenv("LOOPRA_AGENTS_SKILLS_DIR", "")
	root := filepath.Join(userHome, ".agents", "skills")
	if agentsSkillsRoot() != root {
		t.Fatalf("default agents skills root = %q", agentsSkillsRoot())
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("---\nname: Shared Fixture\ndescription: Shared mounted skill.\n---\nRead guide.txt."), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "guide.txt"), []byte("linked skill resource"), 0o600); err != nil {
		t.Fatal(err)
	}
	testutil.DirectoryLink(t, filepath.Join(root, "shared"), target)
	entries := skillMetadata(home, workspace)
	if len(entries) != 1 || entries[0]["scope"] != "@agents-skills/shared" || entries[0]["name"] != "Shared Fixture" {
		t.Fatalf("default mounted skills = %v", entries)
	}
	if !strings.Contains(instruction(home, workspace), "@agents-skills/shared") {
		t.Fatal("default mounted skill missing from system instruction")
	}
	for path, want := range map[string]string{"": "Read guide.txt.", "guide.txt": "linked skill resource"} {
		text, err := readSkill(home, workspace, "@agents-skills/shared", path)
		if err != nil || !strings.Contains(text, want) {
			t.Fatalf("read mounted resource %q = %q %v", path, text, err)
		}
	}
	for _, name := range []string{"@agents-skills/..", "@agents-skills/../shared"} {
		if _, err := readSkill(home, workspace, name, ""); err == nil {
			t.Fatalf("invalid mount accepted: %q", name)
		}
	}
	if _, err := readSkill(home, workspace, "@agents-skills/shared", "../secret.txt"); err == nil {
		t.Fatal("resource escaped mount")
	}
	t.Setenv("LOOPRA_AGENTS_SKILLS_DIR", t.TempDir())
	if strings.Contains(fmt.Sprint(skillMetadata(home, workspace)), "@agents-skills/shared") {
		t.Fatal("explicit agents directory did not override default")
	}
}

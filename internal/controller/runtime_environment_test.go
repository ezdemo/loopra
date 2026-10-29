package controller

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

func TestTurnEnvironmentFollowsWorkspace(t *testing.T) {
	_, _, s, _ := parityServer(t, "")
	workspaces := []string{s.workspaceRoot(), filepath.Join(t.TempDir(), "other-project")}
	for _, workspace := range workspaces {
		if err := os.MkdirAll(workspace, 0o755); err != nil {
			t.Fatal(err)
		}
		view, err := s.projectRuntime(workspace)
		if err != nil {
			t.Fatal(err)
		}
		turn, err := view.prepareTurn(&chatRequest{SessionName: "environment"})
		if err != nil {
			t.Fatal(err)
		}
		for _, text := range []string{turn.agent.Instruction(), turn.subRunner.Environment} {
			for _, want := range []string{
				"Working directory: " + workspace,
				"Operating system: " + runtime.GOOS,
				"Architecture: " + runtime.GOARCH,
				"Shell: " + shellenv.Current.Name,
				"Shell executable: " + shellenv.Current.Path,
			} {
				if !strings.Contains(text, want) {
					t.Fatalf("missing %q in prompt: %s", want, text)
				}
			}
			if strings.Count(text, "[Runtime environment]") != 1 {
				t.Fatalf("duplicated environment in prompt: %s", text)
			}
		}
	}
}

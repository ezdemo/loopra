package shellenv

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDetect(t *testing.T) {
	for _, test := range []struct {
		name      string
		goos      string
		available []string
		want      Shell
	}{
		{"windows pwsh", "windows", []string{"pwsh.exe", "powershell.exe", "cmd.exe"}, Shell{"powershell", "resolved/pwsh.exe"}},
		{"windows powershell", "windows", []string{"powershell.exe", "cmd.exe"}, Shell{"powershell", "resolved/powershell.exe"}},
		{"windows cmd", "windows", []string{"cmd.exe"}, Shell{"CMD", "resolved/cmd.exe"}},
		{"mac bash", "darwin", []string{"bash", "sh"}, Shell{"bash", "resolved/bash"}},
		{"linux bash", "linux", []string{"bash", "sh"}, Shell{"bash", "resolved/bash"}},
		{"linux sh", "linux", []string{"sh"}, Shell{"sh", "resolved/sh"}},
		{"windows missing", "windows", nil, Shell{"CMD", "cmd.exe"}},
		{"unix missing", "linux", nil, Shell{"sh", "sh"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := detect(test.goos, func(name string) (string, error) {
				for _, available := range test.available {
					if available == name {
						return "resolved/" + name, nil
					}
				}
				return "", exec.ErrNotFound
			})
			if got != test.want {
				t.Fatalf("got %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestCurrentShellExecutesInWorkspace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	command := "pwd"
	if Current.Name == "powershell" {
		command = "(Get-Location).Path"
	} else if Current.Name == "CMD" {
		command = "cd"
	}
	cmd := Current.Command(ctx, command)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("command failed: %v: %s", err, out)
	}
	if !strings.Contains(string(out), root) {
		t.Fatalf("output %q does not contain workspace %q", out, root)
	}
	failed := Current.Command(ctx, "exit 7")
	if err := failed.Run(); err == nil {
		t.Fatal("nonzero shell exit reported success")
	}
}

func TestInstructionUsesAbsoluteWorkspace(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "project")
	text := Instruction(workspace)
	for _, want := range []string{"Working directory: " + workspace, "Operating system: ", "Architecture: ", "Shell: " + Current.Name, "Shell executable: " + Current.Path, "Command tool: " + Current.Name} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in instruction: %s", want, text)
		}
	}
}

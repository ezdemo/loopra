// Package shellenv keeps shell execution and the agent's environment description consistent.
package shellenv

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/hideconsole"
)

type Shell struct {
	Name string
	Path string
}

// Current is selected once so tool declarations and execution use the same shell.
var Current = detect(runtime.GOOS, exec.LookPath)

// ToolName maps saved settings from the former fixed bash tool names.
func ToolName(name string) string {
	switch name {
	case "bash", "bash_start", "bash_wait", "bash_stdin", "bash_stop":
		return Current.Name + strings.TrimPrefix(name, "bash")
	default:
		return name
	}
}

func detect(goos string, lookPath func(string) (string, error)) Shell {
	candidates := []Shell{{Name: "bash", Path: "bash"}, {Name: "sh", Path: "sh"}}
	if goos == "windows" {
		candidates = []Shell{
			{Name: "powershell", Path: "pwsh.exe"},
			{Name: "powershell", Path: "powershell.exe"},
			{Name: "CMD", Path: "cmd.exe"},
		}
	}
	for _, candidate := range candidates {
		if path, err := lookPath(candidate.Path); err == nil {
			candidate.Path = path
			return candidate
		}
	}
	return candidates[len(candidates)-1]
}

const powershellEncoding = "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false);"

func (s Shell) Command(ctx context.Context, command string) *exec.Cmd {
	var cmd *exec.Cmd
	switch s.Name {
	case "powershell":
		cmd = exec.CommandContext(ctx, s.Path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellEncoding+"\n"+command)
	case "CMD":
		cmd = exec.CommandContext(ctx, s.Path, "/D", "/S", "/C", command)
	default:
		cmd = exec.CommandContext(ctx, s.Path, "-c", command)
	}
	hideconsole.Apply(cmd)
	return cmd
}

func (s Shell) InteractiveCommand() *exec.Cmd {
	var cmd *exec.Cmd
	switch s.Name {
	case "powershell":
		cmd = exec.Command(s.Path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-")
	case "CMD":
		cmd = exec.Command(s.Path, "/D", "/Q")
	default:
		cmd = exec.Command(s.Path)
	}
	hideconsole.Apply(cmd)
	return cmd
}

func (s Shell) Input(input string) string {
	input = strings.ReplaceAll(input, "\r\n", "\n")
	if s.Name == "powershell" {
		// A blank line submits compound statements when PowerShell reads from stdin.
		return input + "\n\n"
	}
	if s.Name == "CMD" {
		return strings.ReplaceAll(input, "\n", "\r\n") + "\r\n"
	}
	return input + "\n"
}

func (s Shell) InitializeInput() string {
	if s.Name == "powershell" {
		return s.Input(powershellEncoding)
	}
	return ""
}

func Instruction(workspace string) string {
	if workspace == "" {
		workspace, _ = os.Getwd()
	}
	if abs, err := filepath.Abs(workspace); err == nil {
		workspace = abs
	}
	search := "For file search, file listing, and any counting (files, lines, matches), prefer the rg tool (files / files_with_matches / content modes) over shell enumeration or per-file text scans: rg respects .gitignore and is usually orders of magnitude faster."
	if Current.Name == "powershell" {
		search += " Avoid `Get-ChildItem -Recurse -Include ... | Where-Object ...` followed by per-file Get-Content/Measure-Object/Select-String loops: Where-Object filters only after the full traversal, so such scans can take tens of seconds in large trees."
	}
	return fmt.Sprintf("[Runtime environment]\nWorking directory: %s\nOperating system: %s\nArchitecture: %s\nShell: %s\nShell executable: %s\nCommand tool: %s\nInteractive tools: %s_start, %s_wait, %s_stdin, %s_stop\nUse this shell's syntax for commands and paths. Commands start in the working directory above; each one-shot call starts a new shell.\n%s\nCommand arguments: cwd (project-relative or workspace-absolute directory), max_char (default 64000, max 200000), timeout seconds (default 120, max 3600). Interactive tools also accept cwd, max_char, and timeout; their timeout only limits the current wait. Output is marked with truncated=true and a clear message when max_char is exceeded; one-shot timeouts return status=timed_out.",
		workspace, runtime.GOOS, runtime.GOARCH, Current.Name, Current.Path, Current.Name,
		Current.Name, Current.Name, Current.Name, Current.Name, search)
}

package acp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTUIArgs(t *testing.T) {
	cases := []struct {
		agent string
		start TUIStart
		want  string
	}{
		{"claude-code", TUIStart{ResumeID: "uuid-1"}, "--session-id uuid-1"},
		{"claude-code", TUIStart{Resume: true, ResumeID: "uuid-1"}, "--resume uuid-1"},
		{"claude-code", TUIStart{}, ""},
		{"claude-code", TUIStart{Resume: true}, ""},
		{"codex", TUIStart{}, ""},
		{"codex", TUIStart{Resume: true}, "resume --last"},
		{"devin", TUIStart{}, ""},
		{"devin", TUIStart{Resume: true}, "-c"},
	}
	for _, c := range cases {
		got := strings.Join(tuiArgs(c.agent, c.start), " ")
		if got != c.want {
			t.Fatalf("tuiArgs(%q, %+v) = %q, want %q", c.agent, c.start, got, c.want)
		}
	}
}

func TestCliCommandFor(t *testing.T) {
	cmd, err := cliCommandFor("windows", `C:\tools\claude.cmd`, "--resume", "x")
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd) < 4 || cmd[1] != "/c" || cmd[2] != `C:\tools\claude.cmd` || cmd[3] != "--resume" || cmd[4] != "x" {
		t.Fatalf("windows .cmd wrap = %v", cmd)
	}
	if _, err := cliCommandFor("windows", `C:\tools\claude.ps1`); err == nil {
		t.Fatal(".ps1 shim accepted")
	}
	cmd, err = cliCommandFor("linux", "/usr/bin/claude", "--resume", "x")
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd) != 3 || cmd[0] != "/usr/bin/claude" || cmd[1] != "--resume" {
		t.Fatalf("linux command = %v", cmd)
	}
	exe, err := cliCommandFor("windows", `C:\tools\devin.exe`, "-c")
	if err != nil {
		t.Fatal(err)
	}
	if len(exe) != 2 || exe[0] != `C:\tools\devin.exe` {
		t.Fatalf("windows .exe should not be wrapped: %v", exe)
	}
}

func fakeCLI(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func lastArg(command []string) []string {
	if len(command) > 1 && strings.EqualFold(filepath.Base(command[0]), "cmd.exe") {
		return command[3:]
	}
	return command[1:]
}

func cliName() string {
	if runtime.GOOS == "windows" {
		return "cli.exe"
	}
	return "cli"
}

func TestTUILaunchProviders(t *testing.T) {
	// env 覆盖让测试不依赖真实 CLI；命令尾部参数各平台一致。
	t.Run("codex first spawn", func(t *testing.T) {
		t.Setenv("LOOPRA_CODEX_EXECUTABLE", fakeCLI(t, cliName()))
		launch, err := TUILaunch("codex", TUIStart{})
		if err != nil {
			t.Fatal(err)
		}
		if got := lastArg(launch.Command); len(got) != 0 {
			t.Fatalf("codex first spawn = %v", launch.Command)
		}
		if launch.Env["PATH"] == "" {
			t.Fatal("PATH env missing")
		}
	})
	t.Run("codex resume", func(t *testing.T) {
		t.Setenv("LOOPRA_CODEX_EXECUTABLE", fakeCLI(t, cliName()))
		launch, err := TUILaunch("codex", TUIStart{Resume: true})
		if err != nil {
			t.Fatal(err)
		}
		if got := lastArg(launch.Command); strings.Join(got, " ") != "resume --last" {
			t.Fatalf("codex resume = %v", launch.Command)
		}
	})
	t.Run("claude first spawn", func(t *testing.T) {
		t.Setenv("CLAUDE_CODE_EXECUTABLE", fakeCLI(t, cliName()))
		launch, err := TUILaunch("claude-code", TUIStart{ResumeID: "uuid-7"})
		if err != nil {
			t.Fatal(err)
		}
		if got := lastArg(launch.Command); strings.Join(got, " ") != "--session-id uuid-7" {
			t.Fatalf("claude first spawn = %v", launch.Command)
		}
	})
	t.Run("claude resume", func(t *testing.T) {
		t.Setenv("CLAUDE_CODE_EXECUTABLE", fakeCLI(t, cliName()))
		launch, err := TUILaunch("claude-code", TUIStart{Resume: true, ResumeID: "uuid-7"})
		if err != nil {
			t.Fatal(err)
		}
		if got := lastArg(launch.Command); strings.Join(got, " ") != "--resume uuid-7" {
			t.Fatalf("claude resume = %v", launch.Command)
		}
	})
	t.Run("devin first spawn", func(t *testing.T) {
		t.Setenv("LOOPRA_DEVIN_EXECUTABLE", fakeCLI(t, cliName()))
		launch, err := TUILaunch("devin", TUIStart{})
		if err != nil {
			t.Fatal(err)
		}
		if got := lastArg(launch.Command); len(got) != 0 {
			t.Fatalf("devin first spawn = %v", launch.Command)
		}
	})
	t.Run("devin resume", func(t *testing.T) {
		t.Setenv("LOOPRA_DEVIN_EXECUTABLE", fakeCLI(t, cliName()))
		launch, err := TUILaunch("devin", TUIStart{Resume: true})
		if err != nil {
			t.Fatal(err)
		}
		if got := lastArg(launch.Command); strings.Join(got, " ") != "-c" {
			t.Fatalf("devin resume = %v", launch.Command)
		}
	})
}

func TestTUILaunchUnknownAgent(t *testing.T) {
	if _, err := TUILaunch("native", TUIStart{}); err == nil {
		t.Fatal("native accepted")
	}
	if _, err := TUILaunch("no-such-agent", TUIStart{}); err == nil {
		t.Fatal("unknown agent accepted")
	}
}

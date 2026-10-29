package tools

import (
	"io"
	"strings"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

func TestBashSessionLifecycle(t *testing.T) {
	root := t.TempDir()
	s, err := startBashSession(root, "echo hello-$$")
	if err != nil {
		t.Skipf("interactive shell unavailable: %v", err)
	}
	defer s.stop()
	out := s.wait(0, 1500, 10000)
	if !strings.Contains(out, "hello-") {
		t.Fatalf("startup output = %q", out)
	}
	// stdin 往返测试
	mark := s.mark()
	if _, err := io.WriteString(s.stdin, shellenv.Current.Input("echo second-line")); err != nil {
		t.Fatal(err)
	}
	out = s.wait(mark, 1500, 10000)
	if !strings.Contains(out, "second-line") {
		t.Fatalf("stdin output = %q", out)
	}
	if shellenv.Current.Name == "powershell" {
		mark = s.mark()
		command := "if ($true) {\n$loopraxValue = 'persistent-value'\nWrite-Output ([char]0x4e2d)\n}"
		if _, err := io.WriteString(s.stdin, shellenv.Current.Input(command)); err != nil {
			t.Fatal(err)
		}
		if out := s.wait(mark, 1500, 10000); !strings.Contains(out, "\u4e2d") {
			t.Fatalf("multiline UTF-8 output = %q", out)
		}
		mark = s.mark()
		if _, err := io.WriteString(s.stdin, shellenv.Current.Input("Write-Output $loopraxValue")); err != nil {
			t.Fatal(err)
		}
		if out := s.wait(mark, 1500, 10000); !strings.Contains(out, "persistent-value") {
			t.Fatalf("session state was lost: %q", out)
		}
	}
	// 注册表视图
	if got := BashSessionsSnapshot(); len(got) != 1 {
		t.Fatalf("snapshot = %v", got)
	}
	if log, ok := BashSessionLog(s.id); !ok || !strings.Contains(log, "hello-") {
		t.Fatalf("log = %q ok = %v", log, ok)
	}
	if n := BashSessionTerminate(s.id); n != 1 {
		t.Fatalf("terminate = %d", n)
	}
	// 等待进程完全退出，以便 TempDir 清理时能删除文件
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("session did not exit after terminate")
	}
}

func TestBashSessionUnknownID(t *testing.T) {
	if _, ok := BashSessionLog("nope"); ok {
		t.Fatal("unknown id resolved")
	}
	if n := BashSessionTerminate("nope"); n != 0 {
		t.Fatalf("terminate unknown = %d", n)
	}
}

func TestBashToolsRegistered(t *testing.T) {
	names := map[string]bool{}
	for _, tl := range BashTools(t.TempDir()) {
		if tl.Tool.Name() != tl.Meta.Name {
			t.Fatalf("declaration name %q differs from metadata %q", tl.Tool.Name(), tl.Meta.Name)
		}
		names[tl.Meta.Name] = true
	}
	for _, suffix := range []string{"_start", "_wait", "_stdin", "_stop"} {
		want := shellenv.Current.Name + suffix
		if !names[want] {
			t.Fatalf("missing %s", want)
		}
	}
}

func TestCommandToolMatchesShell(t *testing.T) {
	entries := FileTools(t.TempDir())
	commandTool := entries[len(entries)-1]
	if commandTool.Meta.Name != shellenv.Current.Name || commandTool.Tool.Name() != shellenv.Current.Name {
		t.Fatalf("command tool = %s (%s), shell = %s", commandTool.Meta.Name, commandTool.Tool.Name(), shellenv.Current.Name)
	}
}

func TestLegacyShellSettings(t *testing.T) {
	registry := NewRegistry(append(FileTools(t.TempDir()), BashTools(t.TempDir())...)...)
	registry.Configure([]string{"bash", "bash_start"}, []string{"bash_stdin"}, map[string]bool{"bash": true})
	if !registry.Disabled(shellenv.Current.Name) || !registry.Disabled(shellenv.Current.Name+"_start") {
		t.Fatal("saved disabled shell tools became enabled after rename")
	}
	for _, entry := range registry.List() {
		if entry["name"] == shellenv.Current.Name && entry["readOnlyOverride"] != true {
			t.Fatal("saved read-only override was lost")
		}
		if entry["name"] == shellenv.Current.Name+"_stdin" && entry["autoApproved"] != true {
			t.Fatal("saved auto-approval setting was lost")
		}
	}
	if shellenv.Current.Name != "bash" {
		registry.Configure(nil, nil, map[string]bool{"bash": true, shellenv.Current.Name: false})
		for _, entry := range registry.List() {
			if entry["name"] == shellenv.Current.Name && entry["readOnlyOverride"] != false {
				t.Fatal("legacy override replaced the explicitly configured shell setting")
			}
		}
	}
}

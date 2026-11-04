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
	s, err := startBashSession(root, "echo hello-$$", testSessionOwner("sess-a"))
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
	if got := BashSessionsSnapshot(testSessionOwner("sess-a")); len(got) != 1 {
		t.Fatalf("snapshot = %v", got)
	}
	if log, ok := BashSessionLog(s.id, testSessionOwner("sess-a")); !ok || !strings.Contains(log, "hello-") {
		t.Fatalf("log = %q ok = %v", log, ok)
	}
	if n := BashSessionTerminate(s.id, testSessionOwner("sess-a")); n != 1 {
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
	if _, ok := BashSessionLog("nope", testSessionOwner("sess-a")); ok {
		t.Fatal("unknown id resolved")
	}
	if n := BashSessionTerminate("nope", testSessionOwner("sess-a")); n != 0 {
		t.Fatalf("terminate unknown = %d", n)
	}
}

// 面板注册表是进程级共享的，但每个后台进程归属于启动它的会话：
// 其它会话既看不到、也读不到、更杀不掉它。
func TestBashSessionsAreScopedToTheirOwnerSession(t *testing.T) {
	root := t.TempDir()
	mine, err := startBashSession(root, "echo mine-$$", testSessionOwner("sess-a"))
	if err != nil {
		t.Skipf("interactive shell unavailable: %v", err)
	}
	defer mine.stop()
	theirs, err := startBashSession(root, "echo theirs-$$", testSessionOwner("sess-b"))
	if err != nil {
		t.Fatalf("second session: %v", err)
	}
	defer theirs.stop()

	// 归属过滤：各自只看得到自己的进程。
	if got := BashSessionsSnapshot(testSessionOwner("sess-a")); len(got) != 1 || got[0]["sessionId"] != mine.id {
		t.Fatalf("sess-a snapshot = %v", got)
	}
	if got := BashSessionsSnapshot(testSessionOwner("sess-b")); len(got) != 1 || got[0]["sessionId"] != theirs.id {
		t.Fatalf("sess-b snapshot = %v", got)
	}
	if got := BashSessionsSnapshot(testSessionOwner("sess-missing")); len(got) != 0 {
		t.Fatalf("unknown owner must see nothing, got %v", got)
	}

	// 跨会话读日志。
	if _, ok := BashSessionLog(theirs.id, testSessionOwner("sess-a")); ok {
		t.Fatal("sess-a read sess-b output")
	}
	if _, ok := BashSessionEntry(mine.id, testSessionOwner("sess-b")); ok {
		t.Fatal("sess-b read sess-a entry")
	}

	// 跨会话终止。
	if n := BashSessionTerminate(theirs.id, testSessionOwner("sess-a")); n != 0 {
		t.Fatalf("cross-session terminate = %d", n)
	}
	if _, ok := BashSessionEntry(theirs.id, testSessionOwner("sess-b")); !ok {
		t.Fatal("sess-b process was killed by another session")
	}

	// 空 sessionId 只影响调用方自己的会话。
	if n := BashSessionTerminate("", testSessionOwner("sess-a")); n != 1 {
		t.Fatalf("scoped terminate all = %d", n)
	}
	if got := BashSessionsSnapshot(testSessionOwner("sess-b")); len(got) != 1 {
		t.Fatalf("sess-b lost its process: %v", got)
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

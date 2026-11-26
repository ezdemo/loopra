package acp

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// solonCodeFixtureName 返回当前平台上会被识别的 CLI 文件名。
func solonCodeFixtureName() string {
	if runtime.GOOS == "windows" {
		return "soloncode.bat"
	}
	return "soloncode"
}

// writeSolonCodeFixture 在 dir 下创建一个可执行的占位 CLI。
func writeSolonCodeFixture(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, solonCodeFixtureName())
	if err := os.WriteFile(path, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func TestSolonCodeDetection(t *testing.T) {
	home := t.TempDir()
	// Unix 读 HOME，Windows 读 USERPROFILE；同时设置便于跨平台复用同一测试。
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOOPRA_SOLONCODE_EXECUTABLE", "")

	installed := writeSolonCodeFixture(t, filepath.Join(home, ".soloncode", "bin"))
	if got := findSolonCode(nil); got != installed {
		t.Fatalf("home install = %q, want %q", got, installed)
	}

	root := t.TempDir()
	fixture := writeSolonCodeFixture(t, root)
	if got := findSolonCode([]string{root}); got != fixture {
		t.Fatalf("root precedence = %q, want %q", got, fixture)
	}

	t.Setenv("LOOPRA_SOLONCODE_EXECUTABLE", fixture)
	if availability := detectSolonCode(); !availability.Available {
		t.Fatalf("override availability = %+v", availability)
	}
	if got := findSolonCode(nil); got != fixture {
		t.Fatalf("override = %q, want %q", got, fixture)
	}

	missing := filepath.Join(root, "missing"+filepath.Ext(solonCodeFixtureName()))
	t.Setenv("LOOPRA_SOLONCODE_EXECUTABLE", missing)
	if availability := detectSolonCode(); availability.Available ||
		!strings.Contains(availability.Detail, "LOOPRA_SOLONCODE_EXECUTABLE") {
		t.Fatalf("missing availability = %+v", availability)
	}
	if _, err := prepareSolonCode(""); err == nil ||
		!strings.Contains(err.Error(), "LOOPRA_SOLONCODE_EXECUTABLE") {
		t.Fatalf("missing prepare err = %v", err)
	}
}

// TestSolonCodeACPProcess 通过本包的 fake Agent 验证 soloncode 的
// Prepare + stdio 管道能完成 initialize 与 session/new。
func TestSolonCodeACPProcess(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOOPRA_ACP_FAKE", "1")
	if runtime.GOOS == "windows" {
		dir := filepath.Join(t.TempDir(), "tools & 100% space!")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("LOOPRA_ACP_TEST_BINARY", binary)
		bat := filepath.Join(dir, "soloncode.bat")
		content := "@echo off\r\n" +
			"if not \"%~1\"==\"acp\" exit /b 1\r\n" +
			"\"%LOOPRA_ACP_TEST_BINARY%\"\r\n" +
			"exit /b %ERRORLEVEL%\r\n"
		if err := os.WriteFile(bat, []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("LOOPRA_SOLONCODE_EXECUTABLE", bat)
	} else {
		t.Setenv("LOOPRA_SOLONCODE_EXECUTABLE", binary)
	}
	provider, ok := Lookup("soloncode")
	if !ok {
		t.Fatal("soloncode provider missing")
	}
	cwd := t.TempDir()
	launch, err := provider.Prepare(cwd)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(launch, cwd, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	result, err := client.NewSession(ctx, cwd, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "fake-session" {
		t.Fatalf("session id = %q", result.SessionID)
	}
}

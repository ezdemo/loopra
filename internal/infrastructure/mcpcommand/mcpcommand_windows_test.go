//go:build windows

package mcpcommand

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func fakeShimDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cli := filepath.Join(dir, "node_modules", "npm", "bin", "npx-cli.js")
	if err := os.MkdirAll(filepath.Dir(cli), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(dir, "npx.cmd"),
		filepath.Join(dir, "node.exe"),
		cli,
	} {
		if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestCommandWindowsNpxShim(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	dir := fakeShimDir(t)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	cli := filepath.Join(dir, "node_modules", "npm", "bin", "npx-cli.js")
	args := []string{"pkg name", "a&b", "100%", "中文", `say "hi"`, "{{token}}"}
	cmd := Command("npx", args...)
	if cmd.Err != nil {
		t.Fatalf("cmd.Err = %v", cmd.Err)
	}
	if want := filepath.Join(dir, "node.exe"); cmd.Path != want {
		t.Fatalf("Path = %q, want %q", cmd.Path, want)
	}
	want := append([]string{cmd.Path, cli}, args...)
	if len(cmd.Args) != len(want) {
		t.Fatalf("Args = %v", cmd.Args)
	}
	for i := range want {
		if cmd.Args[i] != want[i] {
			t.Fatalf("Args[%d] = %q, want %q", i, cmd.Args[i], want[i])
		}
	}
}

func TestCommandWindowsNpxMissingCompanion(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "npx.cmd"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	cmd := Command("npx", "-y")
	if cmd.Err == nil {
		t.Fatal("expected Err for npx shim without npm cli companion")
	}
}

func TestCommandWindowsNpxCompanionDirectory(t *testing.T) {
	dir := t.TempDir()
	cli := filepath.Join(dir, "node_modules", "npm", "bin", "npx-cli.js")
	if err := os.MkdirAll(cli, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "npx.cmd"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	cmd := Command("npx", "-y")
	if cmd.Err == nil {
		t.Fatal("expected Err when npx-cli.js path is a directory")
	}
}

func TestCommandWindowsOtherCmdPassthrough(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "other.cmd"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	cmd := Command("other", "-y")
	if cmd.Err != nil {
		t.Fatalf("cmd.Err = %v", cmd.Err)
	}
	if filepath.Ext(cmd.Path) != ".cmd" {
		t.Fatalf("other.cmd should pass through unchanged, got %q", cmd.Path)
	}
}

func TestCommandWindowsExePassthrough(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "tool.exe")
	if err := os.WriteFile(exe, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	cmd := Command("tool", "arg one")
	if cmd.Err != nil {
		t.Fatalf("cmd.Err = %v", cmd.Err)
	}
	if cmd.Path != exe {
		t.Fatalf("Path = %q, want %q", cmd.Path, exe)
	}
	if len(cmd.Args) != 2 || cmd.Args[1] != "arg one" {
		t.Fatalf("Args = %v", cmd.Args)
	}
}

func TestCommandWindowsNpxRoundTrip(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	dir := t.TempDir()
	cli := filepath.Join(dir, "node_modules", "npm", "bin", "npx-cli.js")
	if err := os.MkdirAll(filepath.Dir(cli), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cli, []byte("console.log(JSON.stringify(process.argv.slice(2)))"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "npx.cmd"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+filepath.Dir(node))

	args := []string{"pkg name", "a&b", "100%", "中文", `say "hi"`}
	out, err := Command("npx", args...).Output()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output %q: %v", out, err)
	}
	if len(got) != len(args) {
		t.Fatalf("argv = %v", got)
	}
	for i := range args {
		if got[i] != args[i] {
			t.Fatalf("argv[%d] = %q, want %q", i, got[i], args[i])
		}
	}
}

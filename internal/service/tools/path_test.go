package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLinkedPathsExistOnlyInCurrentTurn(t *testing.T) {
	root, linked, other := t.TempDir(), t.TempDir(), t.TempDir()
	ctx := WithWorkspaceScope(WithLinkedProjects(context.Background(), []string{linked}), true)
	if _, err := contextualPath(ctx, root, filepath.Join(linked, "new.txt")); err != nil {
		t.Fatalf("linked path rejected: %v", err)
	}
	for _, test := range []struct {
		ctx  context.Context
		path string
	}{
		{WithWorkspaceScope(context.Background(), true), filepath.Join(linked, "new.txt")},
		{ctx, filepath.Join(other, "new.txt")},
		{ctx, filepath.Join(linked, "..", filepath.Base(other), "new.txt")},
	} {
		if _, err := contextualPath(test.ctx, root, test.path); err == nil {
			t.Fatalf("unlinked path accepted: %s", test.path)
		}
	}
}

// 只读工具在任何设置下都直接解析路径，不套用项目范围。
func TestReadOnlyPathsIgnoreWorkspaceScope(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(target, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readOnlyPath(root, target)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(got) != filepath.Clean(target) {
		t.Fatalf("path = %s, want %s", got, target)
	}
	// 相对路径仍然相对项目根解析。
	got, err = readOnlyPath(root, "nested/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "nested", "file.txt"); filepath.Clean(got) != filepath.Clean(want) {
		t.Fatalf("relative read path = %s, want %s", got, want)
	}
	// ../ 指向项目外的相对路径也能解析。
	if got, err := readOnlyPath(root, "../sibling.txt"); err != nil {
		t.Fatalf("relative escape rejected for read: %v", err)
	} else if filepath.Clean(got) != filepath.Clean(filepath.Join(root, "..", "sibling.txt")) {
		t.Fatalf("relative escape = %s", got)
	}
}

// 默认不限制工作区：写入类工具也能直接用项目外的绝对路径。
func TestWritePathsOutsideWorkspaceAllowedByDefault(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "new.txt")
	if err := os.WriteFile(target, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := contextualPath(context.Background(), root, target)
	if err != nil {
		t.Fatalf("absolute path rejected without the scope switch: %v", err)
	}
	if filepath.Clean(got) != filepath.Clean(target) {
		t.Fatalf("path = %s, want %s", got, target)
	}
	sibling := filepath.Join(filepath.Dir(root), filepath.Base(root)+"-sibling.txt")
	if got, err := contextualPath(context.Background(), root, "../"+filepath.Base(sibling)); err != nil {
		t.Fatalf("relative escape rejected without the scope switch: %v", err)
	} else if filepath.Clean(got) != filepath.Clean(sibling) {
		t.Fatalf("relative path = %s, want %s", got, sibling)
	}
	// 项目内相对路径仍然相对项目根解析。
	inside, err := contextualPath(context.Background(), root, "nested/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(filepath.Dir(inside)) != filepath.Clean(root) {
		t.Fatalf("relative path escaped the project root: %s", inside)
	}
}

func TestWorkspaceScopeRejectsEscapesWhenEnabled(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	ctx := WithWorkspaceScope(context.Background(), true)
	for _, path := range []string{"../outside.txt", filepath.Join(outside, "file.txt")} {
		if _, err := contextualPath(ctx, root, path); err == nil {
			t.Fatalf("restricted path accepted: %s", path)
		}
	}
	if _, err := contextualPath(ctx, root, "nested/file.txt"); err != nil {
		t.Fatalf("project path rejected: %v", err)
	}
}

func TestSafePathRejectsSymlinkEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(root, "escape")
	createDirectoryLink(t, link, outside)
	ctx := WithWorkspaceScope(context.Background(), true)
	for _, path := range []string{"escape", "escape/new/deep/file.txt", filepath.Join(link, "new.txt"), "../outside"} {
		if _, err := contextualPath(ctx, root, path); err == nil {
			t.Fatalf("accepted escaped path %q", path)
		}
	}
	if _, err := safePath(root, "new/deep/file.txt"); err != nil {
		t.Fatalf("rejected a new workspace file: %v", err)
	}
}

func TestUnrestrictedWritePathsFollowDirectoryLinks(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(root, "linked")
	createDirectoryLink(t, link, outside)
	ctx := WithWorkspaceScope(context.Background(), false)
	for _, path := range []string{"linked/new.txt", filepath.Join(link, "new.txt")} {
		abs, err := contextualPath(ctx, root, path)
		if err != nil {
			t.Fatalf("unrestricted path %q: %v", path, err)
		}
		if err := os.WriteFile(abs, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(outside, "new.txt"))
		if err != nil || string(data) != "outside" {
			t.Fatalf("write through %q: content=%q err=%v", path, data, err)
		}
	}
}

func createDirectoryLink(t *testing.T, link, target string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Skipf("symlink creation unavailable: %v", err)
		}
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Junction -Path $env:LOOPRAX_TEST_LINK -Target $env:LOOPRAX_TEST_TARGET -ErrorAction Stop | Out-Null`)
		cmd.Env = append(os.Environ(), "LOOPRAX_TEST_LINK="+link, "LOOPRAX_TEST_TARGET="+target)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("junction fixture failed: %s: %v", output, err)
		}
	}
}

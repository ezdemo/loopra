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
	ctx := WithLinkedProjects(context.Background(), []string{linked})
	if _, err := contextualPath(ctx, root, filepath.Join(linked, "new.txt")); err != nil {
		t.Fatalf("linked path rejected: %v", err)
	}
	for _, test := range []struct {
		ctx  context.Context
		path string
	}{
		{context.Background(), filepath.Join(linked, "new.txt")},
		{ctx, filepath.Join(other, "new.txt")},
		{ctx, filepath.Join(linked, "..", filepath.Base(other), "new.txt")},
	} {
		if _, err := contextualPath(test.ctx, root, test.path); err == nil {
			t.Fatalf("unlinked path accepted: %s", test.path)
		}
	}
}

func TestSafePathRejectsSymlinkEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Skipf("symlink creation unavailable: %v", err)
		}
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Junction -Path $env:LOOPRAX_TEST_LINK -Target $env:LOOPRAX_TEST_TARGET -ErrorAction Stop | Out-Null`)
		cmd.Env = append(os.Environ(), "LOOPRAX_TEST_LINK="+link, "LOOPRAX_TEST_TARGET="+outside)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("junction fixture failed: %s: %v", output, err)
		}
	}
	for _, path := range []string{"escape", "escape/new/deep/file.txt", "../outside"} {
		if _, err := safePath(root, path); err == nil {
			resolved, resolveErr := filepath.EvalSymlinks(link)
			info, _ := os.Lstat(link)
			target, linkErr := os.Readlink(link)
			t.Fatalf("accepted escaped path %q (root=%s outside=%s resolved=%s err=%v mode=%s target=%s linkErr=%v)", path, root, outside, resolved, resolveErr, info.Mode(), target, linkErr)
		}
	}
	if _, err := safePath(root, "new/deep/file.txt"); err != nil {
		t.Fatalf("rejected a new workspace file: %v", err)
	}
}

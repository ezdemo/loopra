package fsutil

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/testutil"
)

func TestMountedDirectoryAllowsExplicitLinkAndBoundsResources(t *testing.T) {
	root, target, outside := t.TempDir(), t.TempDir(), t.TempDir()
	testutil.DirectoryLink(t, filepath.Join(root, "mounted"), target)
	testutil.DirectoryLink(t, filepath.Join(target, "escape"), outside)
	directory, err := MountedDirectory(root, "mounted")
	if err != nil {
		t.Fatal(err)
	}
	want, err := Resolve(target)
	if err != nil || directory != want {
		t.Fatalf("resolved mount = %q, want %q: %v", directory, want, err)
	}
	if _, err := SafeJoin(directory, "references/guide.txt"); err != nil {
		t.Fatalf("resource inside mount rejected: %v", err)
	}
	for _, path := range []string{"../secret.txt", "escape/secret.txt"} {
		if _, err := SafeJoin(directory, path); err == nil {
			t.Fatalf("resource escaped mount: %q", path)
		}
	}
}

func TestMountedDirectoryRejectsInvalidChildren(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", ".", "..", "../outside", `..\outside`, "nested/child", filepath.Join(root, "absolute"), "missing", "file"} {
		if _, err := MountedDirectory(root, name); err == nil {
			t.Fatalf("invalid mount accepted: %q", name)
		}
	}
	if _, err := MountedDirectory("", "fixture"); err == nil {
		t.Fatal("empty root accepted")
	}
}

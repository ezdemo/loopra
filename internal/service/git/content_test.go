package git

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkingFileAtReadsAbsolutePathOutsideWorkspace(t *testing.T) {
	t.Parallel()

	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(outside, []byte("outside\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	file, err := WorkingFileAt(workspace, outside)
	if err != nil {
		t.Fatal(err)
	}
	if !file.Exists || file.Content != "outside\n" {
		t.Fatalf("WorkingFileAt() = %+v", file)
	}
}

func TestWorkingFileAtRejectsRelativePathOutsideWorkspace(t *testing.T) {
	t.Parallel()

	if _, err := WorkingFileAt(t.TempDir(), "../notes.md"); err == nil {
		t.Fatal("WorkingFileAt() accepted a traversing relative path")
	}
}

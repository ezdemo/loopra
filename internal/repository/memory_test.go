package repository

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/model"
)

const legacyMemories = `{"version":1,"entries":[{"id":"old","title":"包管理","content":"使用 pnpm","kind":"fact","source":"user","revision":2}],"future":{"keep":true}}`

func memoryRepositoryFixture(t *testing.T) (*MemoryRepository, string, string, string) {
	t.Helper()
	home, root := t.TempDir(), t.TempDir()
	if err := WriteJSON(filepath.Join(home, "workspace", "project", "workspace.json"), map[string]any{"path": root}); err != nil {
		t.Fatal(err)
	}
	return NewMemoryRepository(home), filepath.Join(home, "workspace", "project", "memories.json"), filepath.Join(root, ".loopra", "memory", "memories.json"), home
}

func TestProjectMemoryMigratesToProjectDirectory(t *testing.T) {
	r, legacy, target, _ := memoryRepositoryFixture(t)
	if entries, err := r.List("project"); err != nil || len(entries) != 0 {
		t.Fatalf("missing memories = %v %v", entries, err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read created empty file: %v", err)
	}
	if err := os.WriteFile(legacy, []byte(legacyMemories), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := r.List("project")
	if err != nil || len(entries) != 1 || entries[0].ID != "old" || entries[0].Revision != 2 {
		t.Fatalf("migration = %v %v", entries, err)
	}
	for _, path := range []string{legacy, target} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != legacyMemories {
			t.Fatalf("migration changed data at %s: %s %v", path, data, err)
		}
	}
	if err := r.Update("project", func(entries []model.Memory) ([]model.Memory, error) {
		entries[0].Content = "使用 pnpm 10"
		entries[0].Revision++
		return entries, nil
	}); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(target)
	if err != nil || !bytes.Contains(updated, []byte("pnpm 10")) || !bytes.Contains(updated, []byte(`"keep": true`)) {
		t.Fatalf("updated project file = %s %v", updated, err)
	}
	backup, err := os.ReadFile(legacy)
	if err != nil || string(backup) != legacyMemories {
		t.Fatalf("legacy backup changed = %s %v", backup, err)
	}
}

func TestProjectMemoryPrefersNewFileIncludingEmptyData(t *testing.T) {
	r, legacy, target, _ := memoryRepositoryFixture(t)
	if err := os.WriteFile(legacy, []byte(legacyMemories), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(target, []byte(`{"version":1,"entries":[]}`)); err != nil {
		t.Fatal(err)
	}
	entries, err := r.List("project")
	if err != nil || len(entries) != 0 {
		t.Fatalf("old memories restored over new file = %v %v", entries, err)
	}
	if err := WriteFile(target, []byte(`broken`)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.List("project"); err == nil {
		t.Fatal("corrupt project file fell back to stale legacy data")
	}
}

func TestProjectMemoryMigrationPreservesCorruptOrUnwritableStorage(t *testing.T) {
	t.Run("corrupt legacy", func(t *testing.T) {
		r, legacy, target, _ := memoryRepositoryFixture(t)
		if err := os.WriteFile(legacy, []byte(`broken`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := r.List("project"); err == nil {
			t.Fatal("corrupt legacy accepted")
		}
		if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("corrupt legacy copied: %v", err)
		}
		data, err := os.ReadFile(legacy)
		if err != nil || string(data) != "broken" {
			t.Fatalf("corrupt legacy changed = %s %v", data, err)
		}
	})
	t.Run("unwritable target", func(t *testing.T) {
		r, legacy, target, _ := memoryRepositoryFixture(t)
		if err := os.WriteFile(legacy, []byte(legacyMemories), 0o600); err != nil {
			t.Fatal(err)
		}
		blocked := filepath.Dir(filepath.Dir(target))
		if err := os.WriteFile(blocked, []byte("occupied"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := r.List("project"); err == nil {
			t.Fatal("migration silently ignored write failure")
		}
		data, err := os.ReadFile(legacy)
		if err != nil || string(data) != legacyMemories {
			t.Fatalf("failed migration changed backup = %s %v", data, err)
		}
	})
}

func TestGlobalMemoryLocationIsIndependentOfProjectRegistry(t *testing.T) {
	r, _, _, home := memoryRepositoryFixture(t)
	if err := r.Update("", func([]model.Memory) ([]model.Memory, error) {
		return []model.Memory{{ID: "global", Title: "偏好", Content: "中文", Kind: "preference", Revision: 1}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "memories.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.List("unknown-project"); err == nil {
		t.Fatal("unregistered project accepted")
	}
}

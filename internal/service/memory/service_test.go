package memory

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/repository"
)

func saveMemory(t *testing.T, service *Service, project, title, content string) model.Memory {
	t.Helper()
	entry, err := service.Save(project, model.Memory{Title: title, Content: content, Kind: "fact"}, "user")
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestPersistenceScopeAndRevision(t *testing.T) {
	home := t.TempDir()
	for _, project := range []string{"project-a", "project-b"} {
		root := filepath.Join(home, "projects", project)
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := repository.WriteJSON(filepath.Join(home, "workspace", project, "workspace.json"), map[string]any{"path": root}); err != nil {
			t.Fatal(err)
		}
	}
	s := NewService(repository.NewMemoryRepository(home))
	global := saveMemory(t, s, "", "Node 管理", "本机通过 nvm 切换 Node 版本")
	project := saveMemory(t, s, "project-a", "包管理", "项目使用 pnpm")
	if entry, err := s.Read("project-a", project.ID); err != nil || entry.Content != project.Content {
		t.Fatalf("read = %v %v", entry, err)
	}
	for _, scope := range []string{"", "project-b"} {
		if _, err := s.Read(scope, project.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-scope read = %v", err)
		}
	}
	if _, err := s.Read("project-a", ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty id = %v", err)
	}
	if _, err := s.Save("project-b", project, "agent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-project update = %v", err)
	}
	project.Content = "项目使用 pnpm 10"
	updated, err := s.Save("project-a", project, "agent")
	if err != nil || updated.Revision != 2 || updated.CreatedAt != project.CreatedAt || updated.Source != "agent" {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if _, err := s.Save("project-a", project, "user"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save = %v", err)
	}
	if err := s.Delete("project-a", project.ID, project.Revision); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale delete = %v", err)
	}
	reopened := NewService(repository.NewMemoryRepository(home))
	entries, err := reopened.List("", "NVM Node")
	if err != nil || len(entries) != 1 || entries[0].ID != global.ID {
		t.Fatalf("reopen = %v %v", entries, err)
	}
	if entries, err := reopened.List("project-b", ""); err != nil || len(entries) != 0 {
		t.Fatalf("project isolation = %v %v", entries, err)
	}
	if err := reopened.Delete("project-a", updated.ID, updated.Revision); err != nil {
		t.Fatal(err)
	}
	if entries, err := reopened.List("project-a", ""); err != nil || len(entries) != 0 {
		t.Fatalf("delete = %v %v", entries, err)
	}
}

func TestConcurrentWritesDoNotLoseUpdates(t *testing.T) {
	s := NewService(repository.NewMemoryRepository(t.TempDir()))
	var wg sync.WaitGroup
	errorsOut := make(chan error, 24)
	for i := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Save("", model.Memory{Title: fmt.Sprintf("fact-%d", i), Content: "value", Kind: "fact"}, "agent")
			errorsOut <- err
		}()
	}
	wg.Wait()
	for range 24 {
		if err := <-errorsOut; err != nil {
			t.Fatal(err)
		}
	}
	entries, err := s.List("", "")
	if err != nil || len(entries) != 24 {
		t.Fatalf("concurrent creates = %d %v", len(entries), err)
	}
	entry := entries[0]
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			copy := entry
			copy.Content = fmt.Sprint(i)
			_, err := s.Save("", copy, "user")
			errorsOut <- err
		}()
	}
	wg.Wait()
	a, b := <-errorsOut, <-errorsOut
	if !((a == nil && errors.Is(b, ErrConflict)) || (b == nil && errors.Is(a, ErrConflict))) {
		t.Fatalf("concurrent edit errors = %v / %v", a, b)
	}
}

func TestCorruptStorageAndFailedWritesStayIntact(t *testing.T) {
	for _, raw := range []string{`broken`, `null`, `{"version":2,"entries":[]}`, `{"version":1,"entries":null}`, `{"version":1,"entries":[{"id":"a","title":"x","content":"y","revision":0}]}`} {
		t.Run(raw, func(t *testing.T) {
			home := t.TempDir()
			path := filepath.Join(home, "memories.json")
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			s := NewService(repository.NewMemoryRepository(home))
			if _, err := s.List("", ""); err == nil {
				t.Fatal("corrupt storage read succeeded")
			}
			if _, err := s.Save("", model.Memory{Title: "new", Content: "new", Kind: "fact"}, "user"); err == nil {
				t.Fatal("corrupt storage overwritten")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != raw {
				t.Fatalf("corrupt file changed: %s, %v", data, err)
			}
		})
	}
	home := t.TempDir()
	s := NewService(repository.NewMemoryRepository(home))
	entry := saveMemory(t, s, "", "saved", "old")
	if err := os.Mkdir(filepath.Join(home, "workspace"), 0o700); err != nil {
		t.Fatal(err)
	}
	// 文件占据目录位置，使项目写入失败；全局记录仍须可读。
	if err := os.WriteFile(filepath.Join(home, "workspace", "blocked"), []byte("occupied"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save("blocked", model.Memory{Title: "new", Content: "new", Kind: "fact"}, "agent"); err == nil {
		t.Fatal("unwritable scope succeeded")
	}
	entries, err := s.List("", "")
	if err != nil || len(entries) != 1 || entries[0] != entry {
		t.Fatalf("global changed = %v %v", entries, err)
	}
}

func TestValidationAndDuplicateTitles(t *testing.T) {
	s := NewService(repository.NewMemoryRepository(t.TempDir()))
	saveMemory(t, s, "", "Node", "nvm")
	if _, err := s.Save("", model.Memory{Title: "node", Content: "duplicate", Kind: "fact"}, "agent"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate = %v", err)
	}
	for _, in := range []model.Memory{{Title: " ", Content: "x", Kind: "fact"}, {Title: "x", Content: "x", Kind: "unknown"}, {Title: "x", Content: strings.Repeat("字", 4001), Kind: "fact"}} {
		if _, err := s.Save("", in, "user"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid save = %v", err)
		}
	}
	for _, project := range []string{"../outside", `..\outside`, "C:outside", ".", ".."} {
		if _, err := s.List(project, ""); err == nil {
			t.Fatalf("invalid scope accepted: %s", project)
		}
	}
}

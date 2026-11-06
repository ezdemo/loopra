package projectlinks

import (
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/testutil"
)

func linksFixture(t *testing.T) (*Service, string, string, string) {
	t.Helper()
	home, main, registered, directory := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	if err := repository.WriteJSON(filepath.Join(home, "workspace", "main", "workspace.json"), map[string]any{
		"path": main, "createdAt": 123, "futureField": map[string]any{"keep": true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := repository.WriteJSON(filepath.Join(home, "workspace", "registered", "workspace.json"), map[string]any{
		"path": registered, "displayName": "已有项目", "linkedProjectPaths": []string{directory},
	}); err != nil {
		t.Fatal(err)
	}
	return New(home, &sync.Mutex{}), main, registered, directory
}

func TestSavePartialLinksPreservesOtherFieldsAndLegacyRecords(t *testing.T) {
	s, _, registered, directory := linksFixture(t)
	if err := s.Save("main", nil, []string{directory}); err != nil {
		t.Fatal(err)
	}
	if err := s.Save("main", []string{"registered"}, nil); err != nil {
		t.Fatal(err)
	}
	projects, err := s.Resolve("main", nil)
	if err != nil || len(projects) != 2 || projects[0].Name != "已有项目" || projects[0].Path != registered || projects[1].Path != directory {
		t.Fatalf("mixed links = %v, %v", projects, err)
	}
	meta, err := s.metadata("main")
	if err != nil || !reflect.DeepEqual(Paths(meta), []string{directory}) || !reflect.DeepEqual(Hashes(meta), []string{"registered"}) {
		t.Fatalf("saved links = %v, %v", meta, err)
	}
	if meta["createdAt"] != float64(123) || !reflect.DeepEqual(meta["futureField"], map[string]any{"keep": true}) {
		t.Fatalf("unrelated metadata changed: %v", meta)
	}
	if err := s.Save("main", nil, []string{}); err != nil {
		t.Fatal(err)
	}
	projects, err = s.Resolve("main", nil)
	if err != nil || len(projects) != 1 || projects[0].Hash != "registered" {
		t.Fatalf("clearing paths removed a project link or inherited its links: %v, %v", projects, err)
	}
	if err := s.Save("main", []string{}, nil); err != nil {
		t.Fatal(err)
	}
	projects, err = s.Resolve("main", nil)
	if err != nil || len(projects) != 0 {
		t.Fatalf("cleared links = %v, %v", projects, err)
	}
	legacy, _, _, _ := linksFixture(t)
	projects, err = legacy.Resolve("main", nil)
	if err != nil || len(projects) != 0 {
		t.Fatalf("legacy record without links = %v, %v", projects, err)
	}
}

func TestDirectoryLinksValidateAndDeduplicateBeforeSaving(t *testing.T) {
	s, main, registered, directory := linksFixture(t)
	alias := filepath.Join(t.TempDir(), "alias")
	testutil.DirectoryLink(t, alias, directory)
	if err := s.Save("main", []string{"registered", "registered"}, []string{registered, directory, filepath.Join(directory, "."), alias}); err != nil {
		t.Fatal(err)
	}
	meta, _ := s.metadata("main")
	if !reflect.DeepEqual(Hashes(meta), []string{"registered"}) || !reflect.DeepEqual(Paths(meta), []string{directory}) {
		t.Fatalf("directories were not deduplicated: %v", meta)
	}
	projects, err := s.Resolve("main", []string{"registered"})
	if err != nil || len(projects) != 2 {
		t.Fatalf("temporary and persistent directories were not deduplicated: %v, %v", projects, err)
	}
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	primaryAlias := filepath.Join(t.TempDir(), "primary")
	testutil.DirectoryLink(t, primaryAlias, main)
	tooMany := []string{}
	for range MaxProjects {
		tooMany = append(tooMany, t.TempDir())
	}
	storage := filepath.Join(s.home, "workspace", "main", "workspace.json")
	before, err := os.ReadFile(storage)
	if err != nil {
		t.Fatal(err)
	}
	for _, paths := range [][]string{{""}, {"relative"}, {main}, {primaryAlias}, {file}, {filepath.Join(t.TempDir(), "missing")}, tooMany} {
		if err := s.Save("main", nil, paths); err == nil {
			t.Fatalf("invalid directories accepted: %v", paths)
		}
		after, err := os.ReadFile(storage)
		if err != nil || string(before) != string(after) {
			t.Fatalf("rejected save changed metadata: %v", err)
		}
	}
}

func TestOfflineDirectoryLinksDoNotGrantAccessOrLoseMetadata(t *testing.T) {
	s, _, _, directory := linksFixture(t)
	offline := filepath.Join(t.TempDir(), "offline")
	if err := os.Mkdir(offline, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := s.Save("main", nil, []string{directory, offline}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(offline); err != nil {
		t.Fatal(err)
	}
	projects, err := s.Resolve("main", nil)
	if err != nil || len(projects) != 1 || projects[0].Path != directory {
		t.Fatalf("offline roots = %v, %v", projects, err)
	}
	meta, _ := s.metadata("main")
	if !reflect.DeepEqual(Paths(meta), []string{directory, offline}) {
		t.Fatalf("offline metadata lost: %v", meta)
	}
	if _, err := s.Resolve("main", []string{"missing"}); err == nil {
		t.Fatal("invalid explicit project was silently ignored")
	}
	if projects, err := s.Resolve(chatWorkspace, nil); err != nil || len(projects) != 0 {
		t.Fatalf("pure chat has directory permissions: %v, %v", projects, err)
	}
}

func TestConcurrentPartialSavesKeepProjectAndDirectoryLinks(t *testing.T) {
	s, _, _, directory := linksFixture(t)
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() { <-start; results <- s.Save("main", []string{"registered"}, nil) }()
	go func() { <-start; results <- s.Save("main", nil, []string{directory}) }()
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	meta, err := s.metadata("main")
	if err != nil || !reflect.DeepEqual(Hashes(meta), []string{"registered"}) || !reflect.DeepEqual(Paths(meta), []string{directory}) {
		t.Fatalf("concurrent save lost links: %v, %v", meta, err)
	}
}

// 删除项目前把标识关联改写为目录关联，保证关联不再依赖被删除的项目记录。
func TestDeletingProjectConvertsHashLinksToDirectories(t *testing.T) {
	s, _, registered, directory := linksFixture(t)
	if err := s.Save("main", []string{"registered"}, []string{directory}); err != nil {
		t.Fatal(err)
	}
	if err := s.ConvertToDirectoryLinks("registered"); err != nil {
		t.Fatal(err)
	}
	meta, _ := s.metadata("main")
	if len(Hashes(meta)) != 0 || !reflect.DeepEqual(Paths(meta), []string{directory, registered}) {
		t.Fatalf("converted links = %v", meta)
	}
	if meta["createdAt"] != float64(123) || !reflect.DeepEqual(meta["futureField"], map[string]any{"keep": true}) {
		t.Fatalf("unrelated metadata changed: %v", meta)
	}
	// 项目记录被删后，目录关联仍生效，与「选择文件夹」一致。
	if err := os.RemoveAll(filepath.Join(s.home, "workspace", "registered")); err != nil {
		t.Fatal(err)
	}
	projects, err := s.Resolve("main", nil)
	if err != nil || len(projects) != 2 || projects[0].Path != directory || projects[1].Path != registered {
		t.Fatalf("roots after deleting the project record = %v, %v", projects, err)
	}
}

// 目录已经离线时只清掉标识引用，不因此阻止删除，也不新增无效目录。
func TestDeletingProjectWithOfflineDirectoryClearsHashLink(t *testing.T) {
	s, _, registered, _ := linksFixture(t)
	if err := s.Save("main", []string{"registered"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(registered); err != nil {
		t.Fatal(err)
	}
	if err := s.ConvertToDirectoryLinks("registered"); err != nil {
		t.Fatal(err)
	}
	meta, _ := s.metadata("main")
	if len(Hashes(meta)) != 0 || len(Paths(meta)) != 0 {
		t.Fatalf("offline conversion = %v", meta)
	}
}

func TestCorruptMetadataIsNotOverwrittenByDirectoryLinks(t *testing.T) {
	s, _, _, directory := linksFixture(t)
	file := filepath.Join(s.home, "workspace", "main", "workspace.json")
	if err := os.WriteFile(file, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Save("main", nil, []string{directory}); err == nil {
		t.Fatal("corrupt metadata was accepted")
	}
	if _, err := s.Resolve("main", nil); err == nil {
		t.Fatal("corrupt metadata resolved to empty permissions")
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "{" {
		t.Fatalf("corrupt metadata overwritten: %q, %v", data, err)
	}
}

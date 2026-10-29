package frontend

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestResolvePrefersExplicitDir(t *testing.T) {
	home := t.TempDir()
	explicit := t.TempDir()
	dist := t.TempDir()
	writeIndex(t, filepath.Join(home, "static"))
	writeIndex(t, dist)
	dir, files, label := Resolve(explicit, home, []string{dist}, indexFS("embedded"))
	if dir != explicit || files != nil || label != explicit {
		t.Fatalf("explicit = %q %v %q", dir, files, label)
	}
}

func TestResolveUsesDistBeforeInstalledStatic(t *testing.T) {
	home := t.TempDir()
	writeIndex(t, filepath.Join(home, "static"))
	dist := t.TempDir()
	writeIndex(t, dist)
	dir, files, label := Resolve("", home, []string{dist}, indexFS("embedded"))
	abs, err := filepath.Abs(dist)
	if err != nil {
		t.Fatal(err)
	}
	if dir != abs || files != nil || label != abs {
		t.Fatalf("dist = %q %v %q", dir, files, label)
	}
}

func TestResolveUsesEmbeddedBeforeInstalledStatic(t *testing.T) {
	home := t.TempDir()
	writeIndex(t, filepath.Join(home, "static"))
	dir, files, label := Resolve("", home, nil, indexFS("embedded"))
	if dir != "" || !hasIndexFS(files) || label != "embedded" {
		t.Fatalf("embedded = %q %v %q", dir, files, label)
	}
}

func TestResolveUsesDistThenEmbedded(t *testing.T) {
	home := t.TempDir()
	dist := t.TempDir()
	writeIndex(t, dist)
	dir, files, label := Resolve("", home, []string{dist}, indexFS("embedded"))
	abs, err := filepath.Abs(dist)
	if err != nil {
		t.Fatal(err)
	}
	if dir != abs || files != nil || label != abs {
		t.Fatalf("dist = %q %v %q", dir, files, label)
	}

	dir, files, label = Resolve("", home, []string{filepath.Join(home, "missing")}, indexFS("embedded"))
	if dir != "" || files == nil || label != "embedded" {
		t.Fatalf("embedded = %q %v %q", dir, files, label)
	}
	if !hasIndexFS(files) {
		t.Fatal("embedded bundle has no index")
	}
}

func TestResolveWithoutBundleKeepsInstalledPath(t *testing.T) {
	home := t.TempDir()
	dir, files, label := Resolve("", home, nil, nil)
	installed := filepath.Join(home, "static")
	if dir != installed || files != nil || label != installed {
		t.Fatalf("empty = %q %v %q", dir, files, label)
	}
}

func TestDistCandidatesPointAtWebDist(t *testing.T) {
	candidates := DistCandidates()
	if len(candidates) == 0 {
		t.Fatal("no candidates")
	}
	for _, candidate := range candidates {
		if filepath.Base(candidate) != "dist" || filepath.Base(filepath.Dir(candidate)) != "web" {
			t.Fatalf("candidate = %s", candidate)
		}
	}
}

func writeIndex(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>ok</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func indexFS(body string) fstest.MapFS {
	return fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(body)}}
}

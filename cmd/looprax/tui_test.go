package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveTUIClientWithoutPATH(t *testing.T) {
	t.Setenv("PATH", "")
	executable, cleanup, err := resolveTUIClient()
	supported := (runtime.GOOS == "windows" || runtime.GOOS == "darwin" || runtime.GOOS == "linux") &&
		(runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64")
	if !supported {
		if !errors.Is(err, exec.ErrNotFound) {
			t.Fatalf("resolveTUIClient() error = %v, want exec.ErrNotFound", err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("bundled client did not provide cleanup")
	}
	t.Cleanup(func() {
		if err := cleanup(); err != nil {
			t.Error(err)
		}
	})
	name := "micro-acp"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if filepath.Base(executable) != name {
		t.Fatalf("executable = %q, want basename %q", executable, name)
	}
	for _, path := range []string{executable, filepath.Join(filepath.Dir(executable), "LICENSE")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			t.Errorf("%q is not a nonempty regular file", path)
		}
	}
}

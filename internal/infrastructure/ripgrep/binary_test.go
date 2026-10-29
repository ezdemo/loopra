package ripgrep

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestVendoredAssetsMatchManifest(t *testing.T) {
	raw, err := os.ReadFile("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version   string `json:"version"`
		Platforms []struct {
			GOOS         string `json:"goos"`
			GOARCH       string `json:"goarch"`
			BinarySHA256 string `json:"binary_sha256"`
		} `json:"platforms"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != Version {
		t.Fatalf("manifest version %s differs from embedded version %s", manifest.Version, Version)
	}
	for _, platform := range manifest.Platforms {
		t.Run(platform.GOOS+"/"+platform.GOARCH, func(t *testing.T) {
			compressed, err := os.ReadFile(filepath.Join("assets", platform.GOOS+"_"+platform.GOARCH, "rg.gz"))
			if err != nil {
				t.Fatal(err)
			}
			reader, err := gzip.NewReader(bytes.NewReader(compressed))
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.New()
			if _, err := io.Copy(hash, reader); err != nil {
				t.Fatal(err)
			}
			reader.Close()
			if got := hex.EncodeToString(hash.Sum(nil)); got != platform.BinarySHA256 {
				t.Fatalf("binary checksum mismatch: got %s, expected %s", got, platform.BinarySHA256)
			}
		})
	}
}

func TestBundledExecutableWithoutPATH(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("LOOPRA_RG_CACHE", t.TempDir())
	path, err := Executable()
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(path, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "ripgrep "+Version) {
		t.Fatalf("bundled binary did not execute: %v: %s", err, out)
	}
	for _, name := range []string{"COPYING", "LICENSE-MIT", "UNLICENSE"} {
		if info, err := os.Stat(filepath.Join(filepath.Dir(path), name)); err != nil || info.Size() == 0 {
			t.Fatalf("missing license %s: %v", name, err)
		}
	}
}

func TestCachedExecutableRepairsCorruption(t *testing.T) {
	cache := t.TempDir()
	path, err := executableAt(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("corrupt cache"), 0o700); err != nil {
		t.Fatal(err)
	}
	repaired, err := executableAt(cache)
	if err != nil || repaired != path {
		t.Fatalf("cache repair failed: %s %v", repaired, err)
	}
	out, err := exec.Command(repaired, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "ripgrep "+Version) {
		t.Fatalf("repaired binary did not execute: %v: %s", err, out)
	}
}

func TestConcurrentExtraction(t *testing.T) {
	cache := t.TempDir()
	var wg sync.WaitGroup
	paths := make(chan string, 12)
	for i := 0; i < cap(paths); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			path, err := executableAt(cache)
			if err != nil {
				t.Error(err)
				return
			}
			paths <- path
		}()
	}
	wg.Wait()
	close(paths)
	var expected string
	for path := range paths {
		if expected != "" && expected != path {
			t.Fatalf("different executable paths: %s / %s", expected, path)
		}
		expected = path
	}
}

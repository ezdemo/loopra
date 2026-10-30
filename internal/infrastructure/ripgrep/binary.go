// Package ripgrep extracts the target platform's bundled ripgrep without network access.
package ripgrep

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

//go:embed licenses/*
var licenses embed.FS

var (
	loadOnce  sync.Once
	rawBinary []byte
	loadErr   error
	extractMu sync.Mutex
)

func load() ([]byte, error) {
	loadOnce.Do(func() {
		if len(embeddedGzip) == 0 {
			loadErr = fmt.Errorf("no bundled rg for %s/%s; see docs/RG_TOOL.md for supported targets", runtime.GOOS, runtime.GOARCH)
			return
		}
		reader, err := gzip.NewReader(bytes.NewReader(embeddedGzip))
		if err != nil {
			loadErr = err
			return
		}
		defer reader.Close()
		rawBinary, loadErr = io.ReadAll(io.LimitReader(reader, 64*1024*1024))
		if loadErr != nil {
			return
		}
		sum := sha256.Sum256(rawBinary)
		if hex.EncodeToString(sum[:]) != binarySHA256 {
			rawBinary = nil
			loadErr = fmt.Errorf("bundled rg checksum mismatch")
		}
	})
	return rawBinary, loadErr
}

// Executable returns a verified executable extracted from //go:embed assets.
// PATH and system-installed rg binaries are deliberately not consulted.
func Executable() (string, error) {
	cache := os.Getenv("LOOPRA_RG_CACHE")
	if cache != "" {
		if !filepath.IsAbs(cache) {
			return "", fmt.Errorf("LOOPRA_RG_CACHE must be an absolute directory")
		}
	} else {
		base, err := os.UserCacheDir()
		if err != nil {
			return "", fmt.Errorf("resolve rg cache: %w", err)
		}
		cache = filepath.Join(base, "loopra", "rg")
	}
	return executableAt(cache)
}

func executableAt(cache string) (string, error) {
	data, err := load()
	if err != nil {
		return "", err
	}
	extractMu.Lock()
	defer extractMu.Unlock()
	dir := filepath.Join(cache, Version, runtime.GOOS+"-"+runtime.GOARCH, binarySHA256[:16])
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create rg cache: %w", err)
	}
	name := "rg"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(dir, name)
	if validExecutable(target, int64(len(data))) {
		if err := os.Chmod(target, 0o700); err != nil {
			return "", err
		}
		return target, nil
	}
	file, err := os.CreateTemp(dir, ".rg-*")
	if err != nil {
		return "", err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if _, err := file.Write(data); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Chmod(0o700); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temp, target); err != nil {
		// Another Looprax process may have extracted the same binary concurrently.
		if !validExecutable(target, int64(len(data))) {
			return "", fmt.Errorf("publish cached rg: %w", err)
		}
	}
	entries, err := licenses.ReadDir("licenses")
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		notice, err := licenses.ReadFile("licenses/" + entry.Name())
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(dir, entry.Name()), notice, 0o600); err != nil {
			return "", err
		}
	}
	return target, nil
}

func validExecutable(path string, size int64) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(file, size+1)); err != nil {
		return false
	}
	return hex.EncodeToString(hash.Sum(nil)) == binarySHA256
}

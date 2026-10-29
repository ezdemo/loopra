package service

import (
	"crypto/md5"
	"encoding/hex"
	"os"
	"path/filepath"
)

// WorkspaceHash matches the Java backend's twelve-digit MD5 workspace ID.
func WorkspaceHash(dir string) string {
	if dir == "" {
		return "default"
	}
	sum := md5.Sum([]byte(filepath.Clean(dir)))
	return hex.EncodeToString(sum[:6])
}

func PrepareWorkspace(home, dir string) (string, error) {
	if dir == "" {
		dir = filepath.Join(home, "defaultWorkSpace")
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	return root, nil
}

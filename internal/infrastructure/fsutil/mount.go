package fsutil

import (
	"os"
	"path/filepath"
	"strings"
)

// MountedDirectory resolves one explicitly mounted child directory, including
// a symlink or Windows junction to another location. Read its contents through
// SafeJoin with the returned directory as the boundary.
func MountedDirectory(root, name string) (string, error) {
	if root == "" || name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || filepath.IsAbs(name) || filepath.VolumeName(name) != "" {
		return "", ErrInvalidPath
	}
	directory, err := Resolve(filepath.Join(root, name))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(directory)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", ErrInvalidPath
	}
	return directory, nil
}

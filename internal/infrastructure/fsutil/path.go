package fsutil

import (
	"os"
	"path/filepath"
	"strings"
)

// SafeJoin rejects relative paths and symlinks that escape the workspace root.
func SafeJoin(root, rel string) (string, error) {
	root, _ = filepath.Abs(root)
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) {
		return "", ErrInvalidPath
	}
	abs := filepath.Join(root, clean)
	if !WithinPath(root, abs) {
		return "", ErrInvalidPath
	}
	realRoot, err := Resolve(root)
	if err != nil {
		realRoot = root
	}
	parent := abs
	for {
		resolved, err := Resolve(parent)
		if err == nil {
			if !WithinPath(realRoot, resolved) {
				return "", ErrInvalidPath
			}
			suffix, _ := filepath.Rel(parent, abs)
			return filepath.Join(resolved, suffix), nil
		}
		if !os.IsNotExist(err) {
			return "", ErrInvalidPath
		}
		next := filepath.Dir(parent)
		if next == parent {
			return "", ErrInvalidPath
		}
		parent = next
	}
}

func WithinPath(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

type pathError string

func (e pathError) Error() string { return string(e) }

const ErrInvalidPath = pathError("仅允许项目内相对路径")

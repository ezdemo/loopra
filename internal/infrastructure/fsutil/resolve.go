// Package fsutil 解析文件系统路径，用于工作区边界检查。
package fsutil

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Resolve 同时跟随符号链接与 Windows 目录联接（junction）。
// 某些 Go 兼容模式会把联接暴露为 ModeIrregular，filepath.EvalSymlinks
// 会有意不解析它们。
func Resolve(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return resolve(absolute, 0)
}

func resolve(path string, depth int) (string, error) {
	if depth > 255 {
		return "", fmt.Errorf("too many filesystem links")
	}
	path = filepath.Clean(path)
	volume := filepath.VolumeName(path)
	rest := strings.TrimLeft(path[len(volume):], string(filepath.Separator))
	base := volume + string(filepath.Separator)
	if rest == "" {
		_, err := os.Lstat(base)
		return base, err
	}
	parts := strings.Split(rest, string(filepath.Separator))
	for i, part := range parts {
		base = filepath.Join(base, part)
		info, err := os.Lstat(base)
		if err != nil {
			return "", err
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) == 0 {
			continue
		}
		target, err := os.Readlink(base)
		if err != nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return "", err
			}
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(base), target)
		}
		for _, suffix := range parts[i+1:] {
			target = filepath.Join(target, suffix)
		}
		return resolve(target, depth+1)
	}
	return base, nil
}

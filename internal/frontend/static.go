// Package frontend 决定工作台页面从哪里提供。
//
// 显式目录优先。否则使用和桌面同一套自己编译的页面：仓库或可执行文件
// 旁边的 web/dist，然后是带 webdist 标签嵌进二进制的产物。数据目录里的
// static 只在这两处都没有页面时才用。
package frontend

import (
	"io/fs"
	"os"
	"path/filepath"
)

// HasIndex 报告目录里是否有可提供的 index.html。
func HasIndex(dir string) bool {
	if dir == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && !info.IsDir()
}

// Resolve 选择实际提供页面的目录。files 非空时表示使用内嵌页面，
// 此时 dir 为空，避免数据目录里的 static 把编译进二进制的页面盖掉。
// label 用于启动日志：目录路径，或 embedded。
func Resolve(explicit, home string, distCandidates []string, embedded fs.FS) (dir string, files fs.FS, label string) {
	if explicit != "" {
		return explicit, nil, explicit
	}
	for _, candidate := range distCandidates {
		if !HasIndex(candidate) {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil {
			abs = candidate
		}
		return abs, nil, abs
	}
	if hasIndexFS(embedded) {
		return "", embedded, "embedded"
	}
	installed := ""
	if home != "" {
		installed = filepath.Join(home, "static")
	}
	return installed, nil, installed
}

// DistCandidates 是源码树和可执行文件旁边的 web/dist。
func DistCandidates() []string {
	var out []string
	if cwd, err := os.Getwd(); err == nil {
		dir := cwd
		for range 6 {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				out = append(out, filepath.Join(dir, "web", "dist"))
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	if exe, err := os.Executable(); err == nil {
		out = append(out, filepath.Join(filepath.Dir(exe), "web", "dist"))
	}
	return out
}

func hasIndexFS(files fs.FS) bool {
	if files == nil {
		return false
	}
	info, err := fs.Stat(files, "index.html")
	return err == nil && !info.IsDir()
}

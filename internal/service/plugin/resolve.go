package plugin

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
)

func isTS(file string) bool {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".ts", ".tsx", ".mts", ".cts":
		return true
	default:
		return false
	}
}

func locate(root, from, spec string) (string, error) {
	spec = strings.TrimSpace(spec)
	if strings.HasPrefix(spec, "node:") {
		return "", fmt.Errorf("没有内置模块 %s（可用 node:fs、node:fs/promises、node:buffer）", spec)
	}
	if spec == "" || strings.Contains(spec, "://") || filepath.IsAbs(spec) || strings.HasPrefix(spec, "/") {
		return "", fmt.Errorf("不允许导入 %s", spec)
	}
	if spec == "." || spec == ".." || strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
		return resolveExisting(root, filepath.Clean(filepath.Join(from, filepath.FromSlash(spec))))
	}
	return resolveBare(root, from, spec)
}

func resolveBare(root, from, spec string) (string, error) {
	pkg, sub := splitSpec(spec)
	dir := filepath.Clean(from)
	root = filepath.Clean(root)
	for {
		if !inside(root, dir) && dir != root {
			break
		}
		base := filepath.Join(dir, "node_modules", filepath.FromSlash(pkg))
		if info, err := os.Stat(base); err == nil && info.IsDir() {
			if sub == "" {
				return resolvePackageEntry(root, base)
			}
			return resolveExisting(root, filepath.Join(base, filepath.FromSlash(sub)))
		}
		if dir == root {
			break
		}
		next := filepath.Dir(dir)
		if next == dir {
			break
		}
		dir = next
	}
	return "", fmt.Errorf("找不到依赖 %s", spec)
}

func splitSpec(spec string) (string, string) {
	parts := strings.Split(spec, "/")
	if strings.HasPrefix(spec, "@") && len(parts) >= 2 {
		return parts[0] + "/" + parts[1], strings.Join(parts[2:], "/")
	}
	if len(parts) == 0 {
		return spec, ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func resolvePackageEntry(root, dir string) (string, error) {
	info := readPkg(dir)
	if rel := exportDot(info.Exports); rel != "" {
		if file, err := resolveExisting(root, filepath.Join(dir, cleanRel(rel))); err == nil {
			return file, nil
		}
	}
	for _, rel := range []string{info.Module, info.Main, "index.js"} {
		if strings.TrimSpace(rel) == "" {
			continue
		}
		if file, err := resolveExisting(root, filepath.Join(dir, cleanRel(rel))); err == nil {
			return file, nil
		}
	}
	return "", fmt.Errorf("找不到依赖入口 %s", dir)
}

func findEntry(dir, saved string) (string, error) {
	info := readPkg(dir)
	candidates := []string{}
	if saved != "" {
		candidates = append(candidates, saved)
	}
	for _, rel := range []string{info.Loopra, info.Module, info.Main} {
		if strings.TrimSpace(rel) != "" {
			candidates = append(candidates, rel)
		}
	}
	candidates = append(candidates,
		"plugin.ts", "plugin.mts", "plugin.js", "plugin.mjs",
		"index.ts", "index.mts", "index.js", "index.mjs",
		filepath.Join("src", "plugin.ts"), filepath.Join("src", "plugin.js"),
		filepath.Join("src", "index.ts"), filepath.Join("src", "index.js"),
	)
	for _, rel := range candidates {
		file, err := resolveExisting(dir, filepath.Join(dir, cleanRel(rel)))
		if err != nil {
			continue
		}
		out, err := filepath.Rel(dir, file)
		if err != nil {
			continue
		}
		return out, nil
	}
	return "", fmt.Errorf("找不到插件入口（package.json 的 loopra、module 或 main，或 plugin.js / index.js）")
}

func cleanRel(rel string) string {
	rel = strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(rel)), "./")
	return filepath.FromSlash(rel)
}

func resolveExisting(root, target string) (string, error) {
	target = filepath.Clean(target)
	if !inside(root, target) {
		return "", fmt.Errorf("导入越出插件目录")
	}
	if file, ok := existingFile(target); ok {
		return file, nil
	}
	try := []string{}
	switch {
	case strings.HasSuffix(target, ".js"):
		stem := strings.TrimSuffix(target, ".js")
		try = append(try, stem+".ts", stem+".tsx", stem+".mts", stem+".cts")
	case strings.HasSuffix(target, ".mjs"):
		try = append(try, strings.TrimSuffix(target, ".mjs")+".mts")
	default:
		for _, ext := range []string{".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"} {
			try = append(try, target+ext)
		}
		for _, name := range []string{"index.js", "index.mjs", "index.ts", "index.mts"} {
			try = append(try, filepath.Join(target, name))
		}
	}
	for _, candidate := range try {
		if !inside(root, candidate) {
			continue
		}
		if file, ok := existingFile(candidate); ok {
			return file, nil
		}
	}
	return "", fmt.Errorf("找不到模块 %s", target)
}

func existingFile(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return path, true
}

func inside(root, target string) bool {
	root, err1 := filepath.Abs(root)
	target, err2 := filepath.Abs(target)
	if err1 != nil || err2 != nil {
		return false
	}
	return fsutil.WithinPath(root, target)
}

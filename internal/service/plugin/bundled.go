package plugin

import (
	"context"
	"os"
	"path/filepath"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// EnsureBundled 安装 plugins 目录里的附带插件。
// 来源仍是这个目录时，按当前文件重新安装，并保留原来的停用状态。
// 同名但来源不同的插件保持原样。
func (h *Host) EnsureBundled(ctx context.Context) {
	if h == nil || h.home == "" {
		return
	}
	root := findBundledRoot()
	if root == "" {
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		info := readPkg(dir)
		if info.Name == "" {
			continue
		}
		id := pluginID(info.Name)
		abs, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		rec, exists := h.pluginRecord(id)
		if exists && filepath.Clean(rec.Source) != filepath.Clean(abs) {
			continue
		}
		enabled := !exists || rec.Enabled
		if _, err := h.Install(ctx, abs); err != nil {
			logging.Warnf("plugin", "附带插件 %s 安装失败: %v", abs, err)
			continue
		}
		if !enabled {
			if _, err := h.SetEnabled(ctx, id, false); err != nil {
				logging.Warnf("plugin", "附带插件 %s 保持停用失败: %v", id, err)
			}
		}
	}
}

func (h *Host) pluginRecord(id string) (record, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureManifest()
	for _, rec := range h.records {
		if rec.ID == id {
			return rec, true
		}
	}
	return record{}, false
}

func findBundledRoot() string {
	starts := []string{}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, start := range starts {
		dir := start
		for range 8 {
			candidate := filepath.Join(dir, "plugins", "web", "package.json")
			info, err := os.Stat(candidate)
			if err == nil && !info.IsDir() {
				return filepath.Join(dir, "plugins")
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

package plugin

import (
	"context"
	"os"
	"path/filepath"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// EnsureBundled 安装 plugins 目录里的内置插件。
// 来源仍是这个目录时，按当前文件重新安装，并保留用户后来的开关。
// 第一次安装用包里的 defaultEnabled，没写则开启。
// 同名但来源不同的插件保持原样，也不再算内置。
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
	kept := map[string]bool{}
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
		kept[id] = true
		enabled := info.DefaultEnabled
		if exists {
			enabled = rec.Enabled
		}
		if _, err := h.Install(ctx, abs); err != nil {
			logging.Warnf("plugin", "内置插件 %s 安装失败: %v", abs, err)
		} else if !enabled {
			if _, err := h.SetEnabled(ctx, id, false); err != nil {
				logging.Warnf("plugin", "内置插件 %s 保持停用失败: %v", id, err)
			}
		}
		if _, ok := h.pluginRecord(id); ok {
			h.setBuiltin(id, true)
		}
	}
	h.releaseBuiltin(kept)
}

func (h *Host) setBuiltin(id string, builtin bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureManifest()
	for i := range h.records {
		if h.records[i].ID != id || h.records[i].Builtin == builtin {
			continue
		}
		h.records[i].Builtin = builtin
		_ = h.saveLocked()
		return
	}
}

// releaseBuiltin 去掉已经不在 plugins 目录里的内置标记，这样用户可以卸载它。
func (h *Host) releaseBuiltin(keep map[string]bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureManifest()
	changed := false
	for i := range h.records {
		if h.records[i].Builtin && !keep[h.records[i].ID] {
			h.records[i].Builtin = false
			if name := externalizedPlugin(h.records[i].ID); name != "" {
				src, _ := parseGitHub(DefaultSource)
				src.Subdir = "plugins/" + name
				h.records[i].Source = githubSourceURL(src)
			}
			changed = true
		}
	}
	if changed {
		_ = h.saveLocked()
	}
}

// Existing installations keep their copied files, configuration, data and
// enabled state when these plugins move to the external source repository.
func externalizedPlugin(id string) string {
	switch id {
	case "chat_neko":
		return "chat-neko"
	case "daily_review":
		return "daily-review"
	case "openapi":
		return "openapi"
	case "context_lens":
		return "context-lens"
	default:
		return ""
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

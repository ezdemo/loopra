//go:build !386 && !arm

package plugin

import (
	"context"

	"github.com/MoeForge/moejs"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

type hookTarget struct {
	id   string
	run  *running
	hook moejs.Hook
}

// RunHook 按安装顺序调用已启用插件的同名钩子。
// 每个插件看到的是上一个插件改过的输入。stop 返回 true 时不再往后传。
// 插件抛错会被记下并跳过，这一轮继续。返回值是合并后的对象，以及插件实际写过的字段。
func (h *Host) RunHook(ctx context.Context, name string, input map[string]any, stop func(map[string]any) bool) (map[string]any, map[string]bool) {
	merged := cloneMap(input)
	touched := map[string]bool{}
	if h == nil || name == "" {
		return merged, touched
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for _, target := range h.hookTargets(name) {
		callInput := cloneMap(merged)
		if cfg, err := h.UIConfig(target.id); err == nil {
			callInput["config"] = cfg
		}
		out, err := target.run.eval(ctx, target.hook, callInput)
		if err != nil {
			logging.Warnf("plugin", "hook %s plugin=%s: %v", name, target.id, err)
			continue
		}
		obj, ok := out.(map[string]any)
		if !ok {
			continue
		}
		for key, value := range obj {
			if value == nil {
				continue
			}
			merged[key] = value
			touched[key] = true
		}
		if stop != nil && stop(merged) {
			break
		}
	}
	return merged, touched
}

func (h *Host) hookTargets(name string) []hookTarget {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []hookTarget
	for _, rec := range h.records {
		if !rec.Enabled {
			continue
		}
		run := h.loaded[rec.ID]
		if run == nil {
			continue
		}
		hook, ok := run.hooks[name]
		if !ok {
			continue
		}
		out = append(out, hookTarget{id: rec.ID, run: run, hook: hook})
	}
	return out
}

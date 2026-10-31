//go:build !386 && !arm

package plugin

import (
	"context"
	"sort"

	"github.com/MoeForge/moejs"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

type hookTarget struct {
	id   string
	run  *running
	hook moejs.Hook
}

func (h *Host) HasHook(name string) bool {
	return h != nil && len(h.hookTargets(name)) > 0
}

// RunObserver gives every observer its own input. Return values cannot rewrite
// a request or contaminate the next observer's view of what was actually sent.
func (h *Host) RunObserver(ctx context.Context, name string, input map[string]any) {
	if h == nil {
		return
	}
	for _, target := range h.hookTargets(name) {
		payload := cloneMap(input)
		if config, err := h.UIConfig(target.id); err == nil {
			payload["config"] = config
		}
		if _, err := target.run.eval(ctx, target.hook, payload); err != nil {
			logging.Warnf("plugin", "observer %s plugin=%s: %v", name, target.id, err)
		}
	}
}

// RunHook 按 Hook 优先级调用，同优先级保留安装顺序。
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
		if name == HookSystemPrompt {
			text, _ := merged["text"].(string)
			extra, _ := merged["append"].(string)
			callInput["text"] = text + extra
			delete(callInput, "append")
		}
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
		if name == HookSystemPrompt {
			// An explicit replacement consumes earlier appends. Append-only
			// plugins accumulate, and the next plugin sees the effective text.
			if text, ok := obj["text"].(string); ok {
				merged["text"] = text
				merged["append"] = ""
				touched["text"] = true
			}
			if extra, ok := obj["append"].(string); ok {
				previous, _ := merged["append"].(string)
				merged["append"] = previous + extra
				touched["append"] = true
			}
		}
		for key, value := range obj {
			if name == HookSystemPrompt && (key == "text" || key == "append") {
				continue
			}
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
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].run.hookPriority[name] < out[j].run.hookPriority[name]
	})
	return out
}

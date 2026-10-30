package plugin

import (
	"context"
	"sync/atomic"

	"github.com/MoeForge/moejs"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

const (
	HookTurnBefore   = "turnBefore"
	HookSystemPrompt = "systemPrompt"
	HookLLMRequest   = "llmRequest"
	HookLLMResponse  = "llmResponse"
	HookToolBefore   = "toolBefore"
	HookToolAfter    = "toolAfter"
	HookCompact      = "compact"
	HookTurnAfter    = "turnAfter"
)

var hookOrder = []string{
	HookTurnBefore,
	HookSystemPrompt,
	HookLLMRequest,
	HookLLMResponse,
	HookToolBefore,
	HookToolAfter,
	HookCompact,
	HookTurnAfter,
}

// activeHost 让已经组装好的 runner 在控制器创建宿主之后才找到插件。
// 根代理先于宿主存在，钩子在每次回调时读取这个指针。
var activeHost atomic.Pointer[Host]

// SetActive 指定当前进程用来跑钩子的宿主。传 nil 会卸下它。
func SetActive(h *Host) { activeHost.Store(h) }

// Active 返回当前钩子宿主。还没有安装插件时是 nil。
func Active() *Host { return activeHost.Load() }

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
		out, err := target.run.eval(ctx, target.hook, merged)
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

func cloneMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

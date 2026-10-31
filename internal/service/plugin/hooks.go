package plugin

import (
	"sync/atomic"
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

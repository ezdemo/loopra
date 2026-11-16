package controller

import (
	"net/http"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// agentEnginesController 实现 GET /api/agent-engines：原生引擎
// 加上全部外部 ACP Agent；available 标记本机检测结果，hidden 标记
// 用户在设置里关闭展示的条目，选择器只列出可用且未隐藏的引擎。
func (s *Controller) agentEnginesController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	hidden := s.hiddenAgentSet()
	out := []map[string]any{{
		"id": "native", "name": "Loopra Native", "available": true, "detail": "", "hidden": false,
	}}
	for _, provider := range acp.Providers {
		availability := provider.Detect()
		out = append(out, map[string]any{
			"id": provider.ID, "name": provider.Name,
			"available": availability.Available, "detail": availability.Detail,
			"hidden": hidden[provider.ID],
		})
	}
	writeOK(w, http.StatusOK, out)
}

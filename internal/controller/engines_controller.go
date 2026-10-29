package controller

import (
	"net/http"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// agentEnginesController 实现 GET /api/agent-engines：原生引擎
// 加上本机可用的外部 ACP Agent。
func (s *Controller) agentEnginesController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	out := []map[string]any{{
		"id": "native", "name": "Loopra Native", "available": true, "detail": "",
	}}
	for _, provider := range acp.Providers {
		availability := provider.Detect()
		out = append(out, map[string]any{
			"id": provider.ID, "name": provider.Name,
			"available": availability.Available, "detail": availability.Detail,
		})
	}
	writeOK(w, http.StatusOK, out)
}

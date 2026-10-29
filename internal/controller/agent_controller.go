package controller

import (
	"net/http"
	"strings"

	"github.com/ezdemo/looprax/internal/repository"
)

// agentStatusController 实现 GET /api/agent/status。
func (s *Controller) agentStatusController(w http.ResponseWriter, r *http.Request) {
	model := ""
	if s.cfg != nil {
		model = s.cfg.Model
	}
	workspace := ""
	if s.cfg != nil {
		workspace = s.cfg.WorkspaceDir
	}
	view := map[string]any{
		"ready": s.agent != nil, "model": model, "workspace": workspace,
		"cacheSize": 0, "historySize": 0, "hitlMode": hitlMode(s), "sessionName": "",
		"promptTokens": 0, "completionTokens": 0,
	}
	delete(view, "sessionName")
	if s.agent != nil {
		s.state.mu.Lock()
		view["cacheSize"] = len(s.state.runtimes)
		s.state.mu.Unlock()
		if name := s.currentSession(); name != "" {
			if _, err := s.agent.Sessions.Get(r.Context(), getSessionRequest(s.agent, name)); err == nil {
				view["sessionName"] = name
				view["historySize"] = len(s.sessionMessages(r.Context(), name))
				usage := repository.ReadObject(strings.TrimSuffix(s.sessionMetaPath(name), ".meta") + ".usage")
				view["promptTokens"], view["completionTokens"] = number(usage["prompt"]), number(usage["completion"])
			}
		}
	}
	writeOK(w, http.StatusOK, view)
}

func hitlMode(s *Controller) string {
	if s.cfg != nil && s.cfg.Hitl != "" {
		return s.cfg.Hitl
	}
	return "free"
}

// agentHistoryController 实现 GET /api/agent/history 与
// /api/agent/history/events（审计镜像复用同一事件视图；
// Go 会话服务为两者加载完整未截断的集合）。
func (s *Controller) agentHistoryController(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("sessionName")
	if name == "" {
		writeFail(w, http.StatusBadRequest, "sessionName 必填")
		return
	}
	if strings.HasSuffix(r.URL.Path, "/events") {
		writeOK(w, http.StatusOK, s.sessionEvents(name))
		return
	}
	writeOK(w, http.StatusOK, s.sessionMessages(r.Context(), name))
}

// agentSessionStatusController 实现 GET /api/agent/session-status：
// running 由进行中的聊天轮次以及会话标题推导得出。
func (s *Controller) agentSessionStatusController(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("sessionName")
	if name == "" {
		writeFail(w, http.StatusBadRequest, "sessionName 必填")
		return
	}
	requestID := s.sessionRunning(name)
	title := strings.TrimSpace(strOr(s.sessionMetaRead(name), "title", ""))
	if title == "" {
		title = s.sessionDisplayTitle(name, s.sessionMessages(r.Context(), name))
	}
	view := map[string]any{"running": requestID != ""}
	if title != "" {
		view["title"] = title
	}
	if requestID != "" {
		view["requestId"] = requestID
	}
	writeOK(w, http.StatusOK, view)
}

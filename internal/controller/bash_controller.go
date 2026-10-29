package controller

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ezdemo/looprax/internal/service/tools"
)

// bashSessionsController 基于内存中的交互式 shell 注册表
// 实现 /api/agent/bash-sessions 相关接口。
func (s *Controller) bashSessionsController(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/agent/bash-sessions")
	switch action {
	case "":
		sessions := tools.BashSessionsSnapshot()
		// 最新的排在前面（与 Java 端排序一致）
		for i, j := 0, len(sessions)-1; i < j; i, j = i+1, j-1 {
			sessions[i], sessions[j] = sessions[j], sessions[i]
		}
		writeOK(w, http.StatusOK, sessions)
	case "/terminate":
		var body struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.SessionID == "" || tools.BashSessionTerminate(body.SessionID) == 0 {
			writeFail(w, http.StatusBadRequest, "会话不存在或已结束: "+body.SessionID)
			return
		}
		writeOK(w, http.StatusOK, "已关闭后台进程: "+body.SessionID)
	case "/log":
		id := r.URL.Query().Get("sessionId")
		entry, ok := tools.BashSessionEntry(id)
		if !ok {
			writeFail(w, http.StatusBadRequest, "会话不存在或已结束: "+id)
			return
		}
		writeOK(w, http.StatusOK, entry)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

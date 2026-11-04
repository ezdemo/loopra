package controller

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ezdemo/looprax/internal/service/tools"
)

// bashSessionsController 基于内存中的交互式 shell 注册表
// 实现 /api/agent/bash-sessions 相关接口。
//
// 注册表是进程级的，但每个后台进程都归属于启动它的会话，
// 所以三个接口都按 sessionName 过滤：不带该参数时保持全局视图
// （后台管理用），带参数时只暴露该会话自己的进程，
// 既能防止面板串到别的会话/项目，也能防止跨会话终止。
func (s *Controller) bashSessionsController(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/agent/bash-sessions")
	owner := strings.TrimSpace(r.URL.Query().Get("sessionName"))
	switch action {
	case "":
		sessions := tools.BashSessionsSnapshot(owner)
		// 最新的排在前面（与 Java 端排序一致）
		for i, j := 0, len(sessions)-1; i < j; i, j = i+1, j-1 {
			sessions[i], sessions[j] = sessions[j], sessions[i]
		}
		writeOK(w, http.StatusOK, sessions)
	case "/terminate":
		var body struct {
			SessionID   string `json:"sessionId"`
			SessionName string `json:"sessionName"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.SessionName != "" {
			owner = strings.TrimSpace(body.SessionName)
		}
		if body.SessionID == "" {
			// 空 sessionId 表示终止范围内的全部进程；
			// 不限定归属时要求显式带 sessionName，避免误杀别的会话。
			if owner == "" {
				writeFail(w, http.StatusBadRequest, "终止全部后台进程需要指定 sessionName")
				return
			}
			tools.BashSessionTerminate("", owner)
			writeOK(w, http.StatusOK, "已关闭该会话的后台进程")
			return
		}
		if tools.BashSessionTerminate(body.SessionID, owner) == 0 {
			writeFail(w, http.StatusBadRequest, "会话不存在或已结束: "+body.SessionID)
			return
		}
		writeOK(w, http.StatusOK, "已关闭后台进程: "+body.SessionID)
	case "/log":
		id := r.URL.Query().Get("sessionId")
		entry, ok := tools.BashSessionEntry(id, owner)
		if !ok {
			writeFail(w, http.StatusBadRequest, "会话不存在或已结束: "+id)
			return
		}
		writeOK(w, http.StatusOK, entry)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

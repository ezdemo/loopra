package controller

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/ezdemo/looprax/internal/service/hitl"
)

// chatElicitationsController 实现 Agent 反向提问的查询与应答
// GET /api/chat/elicitations 与 POST /api/chat/elicitation
// （Java ChatController 的 elicitations / elicitation）。
func (s *Controller) chatElicitationsController(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		session := r.URL.Query().Get("sessionName")
		if session == "" {
			writeFail(w, http.StatusBadRequest, "sessionName 不能为空")
			return
		}
		writeOK(w, http.StatusOK, s.elicitations.Pending(session))
		return
	}
	var body struct {
		WorkspaceHash        string         `json:"workspaceHash"`
		SessionName          string         `json:"sessionName"`
		ElicitationRequestID string         `json:"elicitationRequestId"`
		Action               string         `json:"action"`
		Content              map[string]any `json:"content"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.WorkspaceHash == "" ||
		body.SessionName == "" || body.ElicitationRequestID == "" {
		writeFail(w, http.StatusBadRequest, "提问答案需要项目、会话和请求 ID")
		return
	}
	if err := s.elicitations.Resolve(body.ElicitationRequestID, body.SessionName, body.Action, body.Content); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "已结束") || strings.Contains(err.Error(), "已处理") {
			status = http.StatusConflict
		}
		writeFail(w, status, err.Error())
		return
	}
	writeOK(w, http.StatusOK, "答案已提交")
}

// chatPermissionsController 在内存 HITL 注册表之上实现
// GET /api/chat/permissions 与 POST /api/chat/permission。待处理
// 审批仅在聊天流等待它们时存在；重启会将其清空
// （Java 注册表的行为相同）。
func (s *Controller) chatPermissionsController(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if r.URL.Query().Get("sessionName") == "" {
			writeFail(w, http.StatusBadRequest, "sessionName 必填")
			return
		}
		pending := s.permissions.Pending(r.URL.Query().Get("sessionName"))
		out := make([]map[string]any, 0, len(pending))
		for _, p := range pending {
			out = append(out, p.ChoicePayload())
		}
		writeOK(w, http.StatusOK, out)
		return
	}
	var body struct {
		WorkspaceHash       string `json:"workspaceHash"`
		SessionName         string `json:"sessionName"`
		PermissionRequestID string `json:"permissionRequestId"`
		OptionID            string `json:"optionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionName == "" ||
		body.PermissionRequestID == "" || body.OptionID == "" {
		writeFail(w, http.StatusBadRequest, "审批需要项目、会话、请求 ID 和选项 ID")
		return
	}
	if err := s.permissions.Resolve(body.PermissionRequestID, body.SessionName, body.OptionID); err != nil {
		if err == hitl.ErrStale {
			writeFail(w, http.StatusConflict, "审批已结束或不属于当前会话")
			return
		}
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, "审批已提交")
}

// subHitlController 为原生子代理审批路径实现
// POST /api/chat/sub-hitl/{subId}：批准/拒绝某个子代理提出的
// 每一个待处理请求。
func (s *Controller) subHitlController(w http.ResponseWriter, r *http.Request) {
	subID := 0
	if v, err := strconv.Atoi(r.PathValue("subId")); err == nil {
		subID = v
	}
	var body struct {
		Action string `json:"action"` // approve | deny
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Action != "approve" && body.Action != "deny" {
		writeFail(w, http.StatusBadRequest, "action 只能是 approve 或 deny")
		return
	}
	option := "reject_once"
	if body.Action == "approve" {
		option = "allow_once"
	}
	if s.permissions.ResolveSub(subID, option) == 0 {
		writeFail(w, http.StatusBadRequest, "当前子代理没有待审批操作")
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"subId": subID, "action": body.Action})
}

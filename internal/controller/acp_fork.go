package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// acpForkPoint 由展示回复的存盘前缀生成适配器的历史分叉扩展
// （Java AcpForkPoint）。
type acpForkPoint struct {
	lines []map[string]any
	meta  map[string]any
}

// acpForkPointAt 计算分叉点；messageCount<=0 表示整段历史。
func acpForkPointAt(source []map[string]any, messageCount int) (acpForkPoint, error) {
	if messageCount <= 0 {
		return acpForkPoint{lines: source}, nil
	}
	if messageCount > len(source) {
		return acpForkPoint{}, fmt.Errorf("messageCount 超过会话消息数")
	}
	prefix := source[:messageCount]
	if messageCount < len(source) {
		if role, _ := source[messageCount]["role"].(string); role != "user" {
			return acpForkPoint{}, fmt.Errorf("请选择一条完整回复作为分叉位置")
		}
	}
	index := len(prefix) - 1
	for ; index >= 0; index-- {
		role, _ := prefix[index]["role"].(string)
		if role == "user" || role == "tool" || hasToolCalls(prefix[index]) {
			return acpForkPoint{}, fmt.Errorf("该回复缺少可定位的最终消息，请选择其他回复")
		}
		if role == "assistant" && strings.TrimSpace(contentOf(prefix[index])) != "" {
			break
		}
	}
	if index < 0 {
		return acpForkPoint{}, fmt.Errorf("该回复缺少可定位的最终消息，请选择其他回复")
	}
	text := contentOf(prefix[index])
	occurrence := 0
	for i := 0; i <= index; i++ {
		if role, _ := prefix[i]["role"].(string); role == "assistant" && contentOf(prefix[i]) == text {
			occurrence++
		}
	}
	messageID, _ := prefix[index]["acp_message_id"].(string)
	if messageID == "" {
		messageID = fmt.Sprintf("loopra-history-%d", index+1)
	}
	sum := sha256.Sum256([]byte(text))
	point := map[string]any{
		"version":            1,
		"messageId":          messageID,
		"messageFingerprint": "sha256:" + hex.EncodeToString(sum[:]),
		"messageOccurrence":  occurrence,
	}
	return acpForkPoint{
		lines: prefix,
		meta: map[string]any{
			"jetbrains": map[string]any{"air": map[string]any{"fork": point}},
		},
	}, nil
}

func contentOf(row map[string]any) string {
	switch value := row["content"].(type) {
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func hasToolCalls(row map[string]any) bool {
	calls, ok := row["tool_calls"].([]any)
	return ok && len(calls) > 0
}

// sessionFork 对 ACP 会话创建远端分叉并复制本地历史前缀
// （Java ExternalAcpSessions.fork）。
func (s *Controller) sessionFork(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPost {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	meta := s.sessionMetaRead(name)
	agentID := strOr(meta, "agentId", "native")
	remote := strOr(meta, "acpSessionId", "")
	if agentID == "native" || !acp.IsExternal(agentID) {
		writeFail(w, http.StatusBadRequest, "当前会话不支持 ACP 分叉")
		return
	}
	if remote == "" {
		writeFail(w, http.StatusBadRequest, "源会话尚未建立远端记录，无法创建分叉")
		return
	}
	count := 0
	if raw := r.URL.Query().Get("messageCount"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			writeFail(w, http.StatusBadRequest, "messageCount 必须为正整数")
			return
		}
		count = value
	}
	point, err := acpForkPointAt(s.sessionMessages(r.Context(), name), count)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	newName := "loopra-" + time.Now().Format("20060102150405")
	conn, err := s.acquireACP(r.Context(), newName, agentID)
	if err != nil {
		writeFail(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	conn.PrepareSetup()
	defer conn.FinishSetup("", nil)
	dirs := append([]string(nil), s.linkedProjectRoots...)
	forked, err := conn.Client().ForkSession(r.Context(), remote, conn.Dir(), dirs, point.meta)
	if err != nil && !forkUnavailable(err) {
		s.acp.Drop(s.acpKey(newName))
		writeFail(w, http.StatusBadGateway, acp.TranslateFailure(err).Error())
		return
	}
	if err != nil {
		// 适配器没有 session/fork 时仍复刻本地会话，并保留 Agent 与模型配置。
		// 下次发送会按这些配置新建 ACP 会话，而不会退回原生引擎。
		s.acp.Drop(s.acpKey(newName))
		forked = ""
	} else if values, ok := meta["agentConfig"].(map[string]any); ok {
		for id, value := range values {
			_, _ = conn.Client().SetConfigOption(r.Context(), id, value)
		}
		conn.BindSession(forked, conn.Client().ConfigOptions())
	} else {
		conn.BindSession(forked, conn.Client().ConfigOptions())
	}
	if _, err := s.agent.Sessions.Create(r.Context(), createReq(s.agent, newName)); err != nil {
		s.acp.Drop(s.acpKey(newName))
		writeFail(w, http.StatusInternalServerError, "新会话创建失败: "+err.Error())
		return
	}
	if err := s.agent.Sessions.AppendTranscript(s.agent.App(), newName, point.lines); err != nil {
		s.acp.Drop(s.acpKey(newName))
		writeFail(w, http.StatusInternalServerError, "复制消息失败: "+err.Error())
		return
	}
	title := strOr(meta, "title", "")
	if title == "" {
		title = name
	}
	prefix := "[分支]"
	if count > 0 {
		prefix = "[复刻]"
	}
	newMeta := inheritedSessionMeta(meta, agentID, forked, conn.Dir(), prefix+title)
	s.sessionMetaWrite(newName, newMeta)
	writeOK(w, http.StatusOK, map[string]any{
		"message": "已分叉到新会话", "workspaceHash": s.agent.App(), "sessionName": newName,
	})
}

// inheritedSessionMeta 复制源会话的 Agent、模型和 ACP 配置。
// forked 为空表示远端没有分叉成功，不能沿用源会话的 acpSessionId。
func inheritedSessionMeta(source map[string]any, agentID, forked, cwd, title string) map[string]any {
	meta := map[string]any{}
	for key, value := range source {
		if key == "acpSessionId" || key == "title" {
			continue
		}
		meta[key] = value
	}
	meta["agentId"] = agentID
	meta["acpCwd"] = cwd
	meta["title"] = title
	if forked != "" {
		meta["acpSessionId"] = forked
	}
	return meta
}

func forkUnavailable(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(err.Error(), "不支持") || strings.Contains(text, "method not found") || strings.Contains(text, "-32601")
}

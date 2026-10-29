package controller

import (
	"context"
	"net/http"
	"os"
	"sort"
	"strings"
)

// sessionsController 基于 JSONL 存储实现会话相关接口。
//
// 会话采用懒物化：只有真正写入了消息的会话才会出现在列表中。
// 新建但从未发送消息的会话只存在于内存（当前会话名）与 .meta
// 设置快照里，既不落盘也不可见——与 Java 的 JsonlSessionStore
// 延迟创建语义一致。唯一的例外是用户显式开启了计划模式（或已有
// 待执行计划）：此时会话只有 .meta，刷新后仍需能被重新发现。
func (s *Controller) sessionsController(w http.ResponseWriter, r *http.Request) {
	list, err := s.agent.Sessions.List(r.Context(), listReq(s.agent))
	if err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]map[string]any, 0, len(list.Sessions))
	listed := make(map[string]bool, len(list.Sessions))
	for _, sess := range list.Sessions {
		name := sess.ID()
		// 存储层为满足 ADK 的 List 契约也会返回仅在内存登记的会话；
		// 它们还没有写入任何消息（或该轮次在产生事件前就失败了），
		// 不应出现在用户可见的会话列表里。计划模式会话由下面的
		// .meta 扫描补回。
		if !s.sessionPersisted(name) {
			continue
		}
		messages := s.sessionMessages(r.Context(), name)
		meta := s.sessionMetaRead(name)
		out = append(out, s.sessionRow(name, meta, messages, sess.LastUpdateTime().UnixMilli()))
		listed[name] = true
	}
	out = append(out, s.metaOnlySessionRows(listed)...)
	order := s.sessionOrderNames()
	sort.SliceStable(out, func(i, j int) bool {
		// 拖拽保存的顺序继续生效。还没写进这份顺序的会话是新建的，
		// 排在最前；同时新建的多条按更新时间从新到旧。
		left, right := sessionOrderRank(order, out[i]["name"].(string)), sessionOrderRank(order, out[j]["name"].(string))
		if left != right {
			return left < right
		}
		return number(out[i]["mtime"]) > number(out[j]["mtime"])
	})
	writeOK(w, http.StatusOK, out)
}

// sessionOrderRank 返回已保存顺序中的位置。不在其中的会话用 -1，
// 从而排在所有已排序会话之前。
func sessionOrderRank(order []string, name string) int {
	for i, item := range order {
		if item == name {
			return i
		}
	}
	return -1
}

// sessionsNew 实现 POST /api/sessions/new。
//
// 与 Java AgentService.newSession 一致，只切换当前会话并固定模型设置，
// 不创建任何会话日志：空白会话在首条消息写入前不应持久化。
func (s *Controller) sessionsNew(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("sessionName")
	if name == "" {
		name = "loopra-" + newMsgID()
	}
	if _, err := s.resolveSessionSettings(name, nil); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	s.setCurrentSession(name)
	if r.URL.Query().Get("worktreeMode") == "true" {
		s.sessionMetaSet(name, map[string]any{"worktreeMode": true})
	}
	writeOK(w, http.StatusOK, map[string]any{
		"message": "已创建新会话", "workspaceHash": s.agent.App(), "sessionName": name,
	})
}

func (s *Controller) sessionsDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if s.sessionRunning(name) != "" {
		writeFail(w, http.StatusConflict, "请先中止正在运行的会话")
		return
	}
	if err := s.removeSession(r.Context(), name); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, http.StatusOK, map[string]any{
		"message": "会话已删除", "workspaceHash": s.agent.App(), "sessionName": name,
	})
}

// removeSession 删除会话日志及其全部边车文件与隔离分支。
func (s *Controller) removeSession(ctx context.Context, name string) error {
	s.dropACP(name)
	if err := s.agent.Sessions.Delete(ctx, delReq(s.agent, name)); err != nil {
		return err
	}
	s.removeSessionSidecars(name)
	s.removeWorktree(name)
	return nil
}

// sessionMetaPending 判断 .meta 是否让只有元数据的会话仍然可见：
// 计划模式可在首条消息前开启，待执行计划也可能尚未消费。
func sessionMetaPending(meta map[string]any) bool {
	return meta["planMode"] == true || strings.TrimSpace(strOr(meta, "pendingPlan", "")) != ""
}

// sessionRow 组装会话列表中的一行。
func (s *Controller) sessionRow(name string, meta map[string]any, messages []map[string]any, mtime int64) map[string]any {
	return map[string]any{
		"name": name, "title": s.sessionDisplayTitle(name, messages), "messageCount": len(messages),
		"current": s.currentSession() == name, "mtime": mtime,
		"worktreeMode": meta["worktreeMode"] == true, "agentId": s.listedAgentID(name, meta),
	}
}

// metaOnlySessionRows 补齐“只有 .meta、尚未写入消息”的计划模式会话，
// 对应 Java list() 对 *.meta 的补充扫描。
func (s *Controller) metaOnlySessionRows(listed map[string]bool) []map[string]any {
	entries, err := os.ReadDir(s.sessionDir())
	if err != nil {
		return nil
	}
	type pendingRow struct {
		name  string
		meta  map[string]any
		mtime int64
	}
	var rows []pendingRow
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".meta") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".meta")
		if listed[name] {
			continue
		}
		meta := s.sessionMetaRead(name)
		if !sessionMetaPending(meta) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		rows = append(rows, pendingRow{name: name, meta: meta, mtime: info.ModTime().UnixMilli()})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].mtime > rows[j].mtime })
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.sessionRow(row.name, row.meta, nil, row.mtime))
	}
	return out
}

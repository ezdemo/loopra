package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/adk/v2/session"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/service/acp"
	sessfiles "github.com/ezdemo/looprax/internal/service/session"
)

func (s *Controller) sessionFiles() *sessfiles.Store {
	app := ""
	if s.agent != nil {
		app = s.agent.App()
	}
	return sessfiles.Open(s.home, app)
}

// sessionDir 是当前项目的会话目录（日志与边车文件同目录）。
func (s *Controller) sessionDir() string { return s.sessionFiles().Dir() }

// sessionLogPath 是会话主日志（{name}.jsonl）的路径。
func (s *Controller) sessionLogPath(name string) string { return s.sessionFiles().LogPath(name) }

// sessionEventsPath 是会话审计镜像（{name}.events）的路径。
func (s *Controller) sessionEventsPath(name string) string {
	return s.sessionFiles().EventsPath(name)
}

// sessionPersisted 判断会话是否已经真正落盘。
func (s *Controller) sessionPersisted(name string) bool { return s.sessionFiles().Persisted(name) }

// sessionMetaPath 对应 Java 的 .meta 边车文件。
func (s *Controller) sessionMetaPath(name string) string { return s.sessionFiles().MetaPath(name) }

func (s *Controller) sessionMetaRead(name string) map[string]any {
	return s.sessionFiles().ReadMeta(name)
}

func (s *Controller) sessionMetaWrite(name string, meta map[string]any) error {
	return s.sessionFiles().WriteMeta(name, meta)
}

func (s *Controller) sessionMetaSet(name string, kv map[string]any, dropEmpty ...string) {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	meta := s.sessionMetaRead(name)
	for k, v := range kv {
		meta[k] = v
	}
	for _, k := range dropEmpty {
		if str, _ := meta[k].(string); str == "" {
			delete(meta, k)
		}
	}
	s.sessionMetaWrite(name, meta)
}

// sessionsDeepController 分发 /api/sessions/{name}/... 以及
// list/new/delete 之外的集合级端点。
func (s *Controller) sessionsDeepController(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	name := r.PathValue("name")
	switch {
	case strings.HasSuffix(path, "/order"):
		s.sessionsOrder(w, r)
	case strings.HasSuffix(path, "/current"):
		s.sessionsCurrent(w)
	case strings.HasSuffix(path, "/settings"):
		s.sessionSettings(w, r, name)
	case strings.HasSuffix(path, "/worktree"):
		s.sessionWorktree(w, r, name)
	case strings.HasSuffix(path, "/title"):
		s.sessionTitle(w, r, name)
	case strings.HasSuffix(path, "/branch"):
		s.sessionBranch(w, r, name)
	case strings.HasSuffix(path, "/fork"):
		s.sessionFork(w, r, name)
	case strings.HasSuffix(path, "/checklist"), strings.HasSuffix(path, "/goal"):
		s.sessionTaskState(w, r, name)
	case strings.HasSuffix(path, "/evict-all"):
		s.state.mu.Lock()
		s.state.runtimes = map[string]*ProjectRuntime{}
		s.state.mu.Unlock()
		writeOK(w, http.StatusOK, "已清除所有 Agent 缓存")
	case strings.HasSuffix(path, "/stats"):
		s.state.mu.Lock()
		size := len(s.state.runtimes)
		s.state.mu.Unlock()
		writeOK(w, http.StatusOK, map[string]any{"cacheSize": size, "maxCacheSize": 50})
	case strings.HasSuffix(path, "/cleanup"):
		s.sessionsCleanup(w, r)
	case strings.HasSuffix(path, "/file-changes/revert"):
		s.fileChangesRevert(w, r)
	case path == "/api/sessions/order" || path == "/api/sessions/current" ||
		path == "/api/sessions/stats" || path == "/api/sessions/evict-all" ||
		path == "/api/sessions/cleanup":
		// 已在上方通过后缀处理
		writeFail(w, http.StatusNotFound, "未找到路径")
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

// sessionsOrder 将保存的顺序写入 config.json 中的
// sessionOrder:<hash>（会话名数组）。
func (s *Controller) sessionsOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	var names []string
	if err := json.NewDecoder(r.Body).Decode(&names); err != nil {
		writeFail(w, http.StatusBadRequest, "格式不正确")
		return
	}
	if err := s.saveConfig(map[string]any{"sessionOrder:" + s.agent.App(): names}); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, http.StatusOK, "排序已保存")
}

func (s *Controller) sessionOrderNames() []string {
	return s.cfg.SessionOrders[s.agent.App()]
}

func (s *Controller) sessionsCurrent(w http.ResponseWriter) {
	view := map[string]any{"workspaceHash": s.agent.App()}
	if name := s.currentSession(); name != "" {
		view["sessionName"] = name
	}
	writeOK(w, http.StatusOK, view)
}

func (s *Controller) sessionSettings(w http.ResponseWriter, r *http.Request, name string) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.resolveSessionSettings(name, nil)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, settings)
	case http.MethodPut:
		var body map[string]*string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeFail(w, http.StatusBadRequest, "格式不正确")
			return
		}
		if v, ok := body["hitl"]; ok && v != nil {
			switch *v {
			case "free", "approval", "auto", "approve", "true", "false", "":
			default:
				writeFail(w, http.StatusBadRequest, "hitl 只能是 free、approval 或 auto")
				return
			}
		}
		kv := map[string]string{}
		for _, k := range []string{"model", "modelChannelId", "reasoningEffort", "hitl"} {
			if v, ok := body[k]; ok && v != nil {
				kv[k] = *v
			}
		}
		settings, err := s.resolveSessionSettings(name, kv)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		if v, ok := kv["hitl"]; ok {
			s.sessionMetaSet(name, map[string]any{"hitl": v}, "hitl")
		}
		writeOK(w, http.StatusOK, settings)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) resolveSessionSettings(name string, requested map[string]string) (map[string]any, error) {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	meta := s.sessionMetaRead(name)
	resolved := map[string]any{}
	for key, fallback := range map[string]string{"model": s.cfg.Model, "modelChannelId": s.cfg.ModelChannelID, "reasoningEffort": s.cfg.ReasoningEffort} {
		value := strings.TrimSpace(requested[key])
		if value == "" {
			value = strings.TrimSpace(strOr(meta, key, fallback))
		}
		if key == "reasoningEffort" && value == "" {
			value = "max"
		}
		resolved[key] = value
	}
	if _, ok := s.cfg.ChannelByID(resolved["modelChannelId"].(string)); !ok {
		if strings.TrimSpace(requested["modelChannelId"]) != "" {
			return nil, fmt.Errorf("模型渠道不存在: %s", resolved["modelChannelId"])
		}
		resolved["modelChannelId"] = s.cfg.ModelChannelID
	}
	changed := false
	for key, value := range resolved {
		if meta[key] != value {
			meta[key], changed = value, true
		}
	}
	if changed {
		if err := s.sessionMetaWrite(name, meta); err != nil {
			return nil, err
		}
	}
	return resolved, nil
}

// listedAgentID 是会话列表展示用的引擎。已停用的 looprax 会先折回 native。
func (s *Controller) listedAgentID(name string, meta map[string]any) string {
	id := strOr(meta, "agentId", "native")
	if id != "looprax" {
		return id
	}
	if migrated := s.migrateRetiredAgent(name); migrated != "" {
		return migrated
	}
	return "native"
}

// migrateRetiredAgent 把工作台里已停用的 looprax 引擎折回 Loopra Native。
// `looprax acp` 仍留给外部客户端；这里只改工作台会话绑定。
func (s *Controller) migrateRetiredAgent(name string) string {
	id := strOr(s.sessionMetaRead(name), "agentId", "")
	if id != "looprax" {
		return id
	}
	s.sessionMetaSet(name, map[string]any{"agentId": "native", "acpSessionId": ""}, "acpSessionId")
	return "native"
}

func strOr(meta map[string]any, key, def string) string {
	if v, ok := meta[key].(string); ok && v != "" {
		return v
	}
	return def
}

func (s *Controller) sessionWorktree(w http.ResponseWriter, r *http.Request, name string) {
	switch r.Method {
	case http.MethodGet:
		meta := s.sessionMetaRead(name)
		mergeMode, _ := meta["mergeMode"].(string)
		if mergeMode == "" {
			mergeMode = "manual"
		}
		writeOK(w, http.StatusOK, map[string]any{
			"workspaceHash": s.agent.App(), "sessionName": name,
			"worktreeMode": meta["worktreeMode"] == true, "mergeMode": mergeMode,
		})
	case http.MethodPut:
		var body struct {
			WorktreeMode *bool  `json:"worktreeMode"`
			MergeMode    string `json:"mergeMode"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeFail(w, http.StatusBadRequest, "格式不正确")
			return
		}
		if body.MergeMode != "" && body.MergeMode != "manual" &&
			body.MergeMode != "ai-auto" && body.MergeMode != "ai-auto-approve" {
			writeFail(w, http.StatusBadRequest, "不支持的隔离分支合并模式")
			return
		}
		kv := map[string]any{}
		if body.WorktreeMode != nil {
			kv["worktreeMode"] = *body.WorktreeMode
		}
		if body.MergeMode != "" {
			kv["mergeMode"] = body.MergeMode
		}
		s.sessionMetaSet(name, kv)
		meta := s.sessionMetaRead(name)
		mergeMode, _ := meta["mergeMode"].(string)
		if mergeMode == "" {
			mergeMode = "manual"
		}
		writeOK(w, http.StatusOK, map[string]any{
			"workspaceHash": s.agent.App(), "sessionName": name,
			"worktreeMode": meta["worktreeMode"] == true, "mergeMode": mergeMode,
		})
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) sessionTitle(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPut {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	var body struct {
		Title string `json:"title"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	title := strings.TrimSpace(body.Title)
	if title == "" || len([]rune(title)) > 100 {
		writeFail(w, http.StatusBadRequest, "标题不能为空且不超过 100 字符")
		return
	}
	s.sessionMetaSet(name, map[string]any{"title": title})
	writeOK(w, http.StatusOK, title)
}

var invalidBranchName = regexp.MustCompile(`[^\p{L}\p{N}_\-\[\]]`)

// sessionBranch 将一个会话的前 messageCount 条消息复制到
// 新建的 loopra-<ts> 会话中（Java branchSession）。
func (s *Controller) sessionBranch(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPost {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	count, convErr := strconv.Atoi(r.URL.Query().Get("messageCount"))
	if convErr != nil || count <= 0 {
		writeFail(w, http.StatusBadRequest, "messageCount 必须为正整数")
		return
	}
	// 外部 Agent 的「从此回复继续到新会话」必须走 ACP 分叉，
	// 才能带上原来的 agent、远端会话和模型配置。
	agentID := s.migrateRetiredAgent(name)
	if agentID == "" {
		agentID = "native"
	}
	if agentID != "native" && acp.IsExternal(agentID) {
		s.sessionFork(w, r, name)
		return
	}
	got, err := s.agent.Sessions.Get(r.Context(), &session.GetRequest{
		AppName: s.agent.App(), UserID: s.agent.User(), SessionID: name,
	})
	if err != nil {
		writeFail(w, http.StatusBadRequest, "会话不存在: "+name)
		return
	}
	events := got.Session.Events()
	if count > events.Len() {
		writeFail(w, http.StatusBadRequest, "messageCount 超过会话消息数")
		return
	}
	newName := "loopra-" + time.Now().Format("20060102150405")
	fresh, err := s.agent.Sessions.Create(r.Context(), createReq(s.agent, newName))
	if err != nil {
		writeFail(w, http.StatusInternalServerError, "新会话创建失败: "+err.Error())
		return
	}
	for i := 0; i < count; i++ {
		ev := events.At(i)
		clone := *ev // 全新 ID：服务在原地分配 ID
		clone.ID = ""
		if err := s.agent.Sessions.AppendEvent(r.Context(), fresh.Session, &clone); err != nil {
			writeFail(w, http.StatusInternalServerError, "复制消息失败: "+err.Error())
			return
		}
	}
	// 继承模型设置与派生标题
	meta := s.sessionMetaRead(name)
	newMeta := map[string]any{}
	for _, k := range []string{"model", "modelChannelId", "reasoningEffort"} {
		if v := strOr(meta, k, ""); v != "" {
			newMeta[k] = v
		}
	}
	if title := strOr(meta, "title", ""); title != "" {
		newMeta["title"] = "[复刻]" + title
	} else {
		newMeta["title"] = "[复刻]" + name
	}
	s.sessionMetaWrite(newName, newMeta)
	writeOK(w, http.StatusOK, map[string]any{
		"message": "已分支到新会话", "workspaceHash": s.agent.App(),
		"sessionName": newName,
	})
}

// sessionsCleanup 删除 mtime 早于 ?before= 的会话：已落盘的会话、
// 只有 .meta 的计划模式会话（列表可见但存储层 List 不返回），以及
// 旧版本遗留的 0 字节空白日志。
func (s *Controller) sessionsCleanup(w http.ResponseWriter, r *http.Request) {
	before, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if err != nil {
		writeFail(w, http.StatusBadRequest, "before 参数不能为空")
		return
	}
	list, err := s.agent.Sessions.List(r.Context(), listReq(s.agent))
	if err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	removed := []string{}
	seen := map[string]bool{}
	for _, sess := range list.Sessions {
		name := sess.ID()
		seen[name] = true
		if s.sessionRunning(name) != "" {
			continue
		}
		if s.sessionPersisted(name) {
			if sess.LastUpdateTime().UnixMilli() < before && s.removeSession(r.Context(), name) == nil {
				removed = append(removed, name)
			}
			continue
		}
		// 仅在内存登记、磁盘上没有会话文件：没有可清理的内容，
		// 不要删掉新建会话刚固定下来的 .meta 设置快照。
		info, err := os.Stat(s.sessionLogPath(name))
		if err != nil || info.ModTime().UnixMilli() >= before {
			continue
		}
		// 旧版本遗留的 0 字节空白日志：按文件修改时间清理。
		if err := os.Remove(s.sessionLogPath(name)); err != nil && !os.IsNotExist(err) {
			continue
		}
		s.removeSessionSidecars(name)
		s.removeWorktree(name)
		removed = append(removed, name)
	}
	// 只有 .meta、尚未写入消息的计划模式会话在列表中可见，但存储层
	// List 不会返回它们，需要单独扫描（对应 Java list() 的 .meta 分支）。
	entries, _ := os.ReadDir(s.sessionDir())
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".meta") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".meta")
		if seen[name] || s.sessionRunning(name) != "" {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().UnixMilli() >= before {
			continue
		}
		if !sessionMetaPending(s.sessionMetaRead(name)) {
			continue
		}
		if s.agent.Sessions.Delete(r.Context(), delReq(s.agent, name)) != nil {
			continue
		}
		s.removeSessionSidecars(name)
		s.removeWorktree(name)
		removed = append(removed, name)
	}
	sort.Strings(removed)
	writeOK(w, http.StatusOK, map[string]any{
		"message": fmt.Sprintf("已清理 %d 个过期会话", len(removed)), "workspaceHash": s.agent.App(), "sessionNames": removed,
	})
}

// removeSessionSidecars 删除已删除会话日志旁边的
// .meta/.events/.usage/.model_usage 文件。
func (s *Controller) removeSessionSidecars(name string) {
	dir := filepath.Dir(s.sessionMetaPath(name))
	base := jsonl.SanitizeName(name)
	for _, ext := range []string{".meta", ".events", ".usage", ".model_usage", ".sub"} {
		_ = os.RemoveAll(filepath.Join(dir, base+ext))
	}
}

// removeWorktree 在存在沙箱工作树时将其删除。
func (s *Controller) removeWorktree(name string) {
	target := gitops.WorktreePath(s.worktreeBase(), s.agent.App(), name)
	main := s.workspaceRoot()
	if !gitops.IsRegisteredWorktree(main, target) {
		return
	}
	gitops.Runner{Dir: main}.Git(gitops.TimeoutWorktree, "worktree", "remove", "--force", target)
	branch := gitops.SandboxBranch(s.agent.App(), name)
	gitops.Runner{Dir: main}.Git(gitops.TimeoutWorktree, "branch", "-D", branch)
}

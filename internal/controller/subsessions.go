package controller

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/ezdemo/looprax/adk/session/jsonl"
)

// 子会话目录布局：{sessionsDir}/{sanitize(parent)}.sub/{id}.jsonl，
// 每行一个 sub_* 事件（Java SubAgentSessionStore）。
var subSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (s *Controller) subSessionsDir(parent string) string {
	return filepath.Join(s.home, "workspace", s.agent.App(), "sessions",
		jsonl.SanitizeName(parent)+".sub")
}

// subEvent 是子会话日志中的一行 JSONL。
type subEvent map[string]any

// readSubEvents 流式读取整个子会话日志。
func readSubEvents(path string) ([]subEvent, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []subEvent
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		var ev subEvent
		if json.Unmarshal([]byte(line), &ev) == nil {
			out = append(out, ev)
		}
	}
	return out, scanner.Err()
}

// subSessionInfo 依据首行（sub_start）与末行（sub_end）
// 推导 DTO，与 Java 的 readInfo 一致。
func subSessionInfo(id string, events []subEvent) map[string]any {
	info := map[string]any{
		"subSessionId": id, "task": "", "name": "", "title": "",
		"profile": "", "status": "running", "startedAt": 0, "endedAt": 0,
		"eventCount": len(events), "mtime": 0,
	}
	if len(events) == 0 {
		return info
	}
	start := events[0]
	for _, key := range []string{"task", "name", "title", "profile"} {
		if v, ok := start[key].(string); ok {
			info[key] = v
		}
	}
	if v, ok := start["startedAt"].(float64); ok {
		info["startedAt"] = int64(v)
	}
	status := "running"
	endedAt := int64(0)
	if last := events[len(events)-1]; last["type"] == "sub_end" {
		if v, ok := last["status"].(string); ok && v != "" {
			status = v
		} else {
			status = "completed"
		}
		if v, ok := last["endedAt"].(float64); ok {
			endedAt = int64(v)
		}
	}
	info["status"] = status
	info["endedAt"] = endedAt
	return info
}

// subSessionsController 处理列表、重放、删除与续聊。
func (s *Controller) subSessionsController(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	parent := r.URL.Query().Get("sessionName")
	switch {
	case strings.HasSuffix(path, "/chat") && r.Method == http.MethodPost:
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/sub-sessions/"), "/chat")
		s.subSessionChat(w, r, id)
	case strings.HasSuffix(path, "/events"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/sub-sessions/"), "/events")
		s.subSessionEvents(w, parent, id)
	case strings.HasPrefix(path, "/api/sub-sessions/"):
		id := strings.TrimPrefix(path, "/api/sub-sessions/")
		if strings.Contains(id, "/") {
			writeFail(w, http.StatusNotFound, "未找到路径")
			return
		}
		switch r.Method {
		case http.MethodDelete:
			s.subSessionDelete(w, parent, id)
		case http.MethodPost:
			s.subSessionChat(w, r, id)
		default:
			writeFail(w, http.StatusNotFound, "未找到路径")
		}
	default:
		if parent == "" {
			writeFail(w, http.StatusBadRequest, "sessionName 必填")
			return
		}
		s.subSessionsList(w, parent)
	}
}

func (s *Controller) subSessionsList(w http.ResponseWriter, parent string) {
	dir := s.subSessionsDir(parent)
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeOK(w, http.StatusOK, []any{})
		return
	}
	infos := []map[string]any{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(name, ".jsonl")
		path := filepath.Join(dir, name)
		events, err := readSubEvents(path)
		if err != nil {
			continue
		}
		info := subSessionInfo(id, events)
		if stat, err := os.Stat(path); err == nil {
			info["mtime"] = stat.ModTime().UnixMilli()
		}
		infos = append(infos, info)
	}
	// 最新的在前
	sort.Slice(infos, func(i, j int) bool {
		return infos[i]["startedAt"].(int64) > infos[j]["startedAt"].(int64)
	})
	writeOK(w, http.StatusOK, infos)
}

func (s *Controller) subSessionEvents(w http.ResponseWriter, parent, id string) {
	if !subSessionIDPattern.MatchString(id) {
		writeFail(w, http.StatusBadRequest, "非法的子会话 ID")
		return
	}
	path := filepath.Join(s.subSessionsDir(parent), id+".jsonl")
	events, err := readSubEvents(path)
	if err != nil {
		writeFail(w, http.StatusBadRequest, "子会话不存在: "+id)
		return
	}
	writeOK(w, http.StatusOK, events)
}

func (s *Controller) subSessionDelete(w http.ResponseWriter, parent, id string) {
	if !subSessionIDPattern.MatchString(id) {
		writeFail(w, http.StatusBadRequest, "非法的子会话 ID")
		return
	}
	path := filepath.Join(s.subSessionsDir(parent), id+".jsonl")
	if _, err := os.Stat(path); err != nil {
		writeFail(w, http.StatusBadRequest, "子会话不存在: "+id)
		return
	}
	if err := os.Remove(path); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"subSessionId": id, "deleted": true})
}

// subSessionChat 通过新的 SSE 流续聊一个已结束的子会话
// （Java SubAgentSessionController chat：子运行把事件
// 流式发送到该连接）。
func (s *Controller) subSessionChat(w http.ResponseWriter, r *http.Request, id string) {
	if !subSessionIDPattern.MatchString(id) {
		writeFail(w, http.StatusBadRequest, "非法的子会话 ID")
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Message) == "" {
		writeFail(w, http.StatusBadRequest, "message 不能为空")
		return
	}
	if s.subRunner == nil {
		writeFail(w, http.StatusBadRequest, "子会话不可续聊或已过期")
		return
	}
	sse := startSSE(w)
	reply, err := s.subRunner.Resume(r.Context(), id, body.Message, ctxSink{s: sse})
	if err != nil {
		sse.sendError(err.Error())
		return
	}
	sse.send("complete", map[string]any{"content": reply})
	sse.done()
}

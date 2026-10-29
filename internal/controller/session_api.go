package controller

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"google.golang.org/adk/v2/session"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/repository"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func getSessionRequest(a *agentpkg.Agent, name string) *session.GetRequest {
	return &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: name}
}

func decodeJSONLines(data []byte) []map[string]any {
	out := []map[string]any{}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		var row map[string]any
		if json.Unmarshal(line, &row) == nil && row != nil {
			out = append(out, row)
		}
	}
	return out
}

func (s *Controller) sessionSwitchController(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	// 切换是惰性的（Java switchSession）：允许指向尚未落盘的新会话，
	// 首条消息写入时才创建会话日志。
	switched := s.currentSession() != name
	s.setCurrentSession(name)
	writeOK(w, http.StatusOK, map[string]any{"workspaceHash": s.agent.App(), "sessionName": name, "switched": switched})
}

func (s *Controller) sessionsClearController(w http.ResponseWriter, r *http.Request) {
	if s.hasRunningProject(s.agent.App()) {
		writeFail(w, http.StatusConflict, "会话正在运行")
		return
	}
	list, err := s.agent.Sessions.List(r.Context(), listReq(s.agent))
	if err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.acp.CloseAll()
	for _, sess := range list.Sessions {
		if err := s.agent.Sessions.Delete(r.Context(), delReq(s.agent, sess.ID())); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.removeSessionSidecars(sess.ID())
		s.removeWorktree(sess.ID())
	}
	// 运行被中断后可能残留孤立的元数据/子会话目录。
	directory := filepath.Join(s.home, "workspace", jsonl.SanitizeName(s.agent.App()), "sessions")
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		target, err := fsutil.SafeJoin(directory, entry.Name())
		if err != nil {
			continue
		}
		if err := os.RemoveAll(target); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	s.state.mu.Lock()
	delete(s.state.runtimes, s.agent.App())
	delete(s.state.current, s.agent.App())
	s.state.mu.Unlock()
	writeOK(w, http.StatusOK, map[string]any{"message": "所有会话已清空", "workspaceHash": s.agent.App()})
}

func (s *Controller) sessionTaskState(w http.ResponseWriter, r *http.Request, name string) {
	goal := strings.HasSuffix(r.URL.Path, "/goal")
	dir := filepath.Join(s.workspaceRoot(), ".loopra", "checklists")
	if goal {
		dir = filepath.Join(s.home, "workspace", s.agent.App(), "goals")
	}
	paths, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, path := range paths {
		entry := repository.ReadObject(path)
		if entry["sessionId"] != name && entry["sessionName"] != name && strings.TrimSuffix(filepath.Base(path), ".json") != jsonl.SanitizeName(name) {
			continue
		}
		if goal {
			entry["goalId"] = entry["id"]
		} else {
			entry["checklistId"] = entry["id"]
		}
		if steps, ok := entry["steps"].([]any); ok {
			done := 0
			for _, step := range steps {
				if m, ok := step.(map[string]any); ok && (m["status"] == "DONE" || m["status"] == "COMPLETED" || m["status"] == "SKIPPED") {
					done++
				}
			}
			entry["totalSteps"], entry["doneSteps"] = len(steps), done
		}
		writeOK(w, http.StatusOK, entry)
		return
	}
	writeOK(w, http.StatusOK, nil)
}

func (s *Controller) sessionEvents(name string) []map[string]any {
	path := filepath.Join(s.home, "workspace", s.agent.App(), "sessions", jsonl.SanitizeName(name)+".events")
	data, err := os.ReadFile(path)
	if err != nil {
		return []map[string]any{}
	}
	return decodeJSONLines(data)
}

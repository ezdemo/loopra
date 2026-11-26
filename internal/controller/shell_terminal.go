package controller

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ezdemo/looprax/internal/service/acp"
	"github.com/ezdemo/looprax/internal/shellterm"
)

func (s *Controller) registerShellTerminalRoutes(api *apiRouter) {
	readRoute(api, "/shell-terminal/sessions", s.action((*Controller).shellTerminalSessions))
	api.POST("/shell-terminal/sessions", s.action((*Controller).shellTerminalOpen))
	api.DELETE("/shell-terminal/sessions/:id", s.action((*Controller).shellTerminalClose))
	api.GET("/shell-terminal/sessions/:id/stream", s.action((*Controller).shellTerminalStream))
}

func (s *Controller) shellTerminalSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"sessions": s.shellHub().List()})
}

func (s *Controller) shellTerminalOpen(w http.ResponseWriter, r *http.Request) {
	dir, err := s.resolveProject("")
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	// 空 body 保持普通登录 shell；带 agentId 时改为启动外部 Agent 的 TUI。
	var body struct {
		AgentID     string `json:"agentId"`
		SessionName string `json:"sessionName"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	agentID := strings.TrimSpace(body.AgentID)
	if agentID == "" {
		info, err := s.shellHub().Open(dir)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, info)
		return
	}
	s.openAgentTerminal(w, r, dir, agentID, body.SessionName)
}

// openAgentTerminal 在项目目录里以交互终端运行外部 Agent CLI。
// sessionName 为空或指向尚无任何记录的名称时按 TUI 会话创建：先写
// .meta（mode/agentId/标题，claude 附 tuiResumeId）再拉起 CLI。
// 已存在的 GUI 会话一律拒绝；已有 TUI 会话的 agentId 必须与请求一致，
// 重开时 PTY 还活着就直接复用，进程已退出则按 tuiStarted 拼续接参数。
func (s *Controller) openAgentTerminal(w http.ResponseWriter, r *http.Request, dir, agentID, sessionName string) {
	provider, ok := acp.Lookup(agentID)
	if !ok || agentID == "soloncode" {
		writeFail(w, http.StatusBadRequest, "该 Agent 不支持 TUI 终端")
		return
	}
	sessionName = strings.TrimSpace(sessionName)
	meta := map[string]any{}
	creating := sessionName == ""
	if !creating {
		meta = s.sessionMetaRead(sessionName)
		switch {
		case strOr(meta, "mode", "") == "tui":
			if strOr(meta, "agentId", "") != agentID {
				writeFail(w, http.StatusBadRequest, "该 TUI 会话绑定了其他 Agent")
				return
			}
		case len(meta) == 0 && !s.sessionExists(r.Context(), sessionName):
			// 同名会话连登记与文件都没有：按创建补齐元数据。
			creating = true
		default:
			writeFail(w, http.StatusBadRequest, "该会话不是 TUI 会话")
			return
		}
	}
	if creating {
		if sessionName == "" {
			sessionName = "loopra-" + newMsgID()
		}
		patch := map[string]any{
			"mode": "tui", "agentId": agentID, "tuiStarted": false,
			"title": provider.Name + " TUI",
		}
		if agentID == "claude-code" {
			patch["tuiResumeId"] = newUUIDv4()
		}
		s.sessionMetaSet(sessionName, patch)
		s.setCurrentSession(sessionName)
		meta = s.sessionMetaRead(sessionName)
	}
	start := acp.TUIStart{
		Resume:   meta["tuiStarted"] == true,
		ResumeID: strOr(meta, "tuiResumeId", ""),
	}
	launch, err := acp.TUILaunch(agentID, start)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	env := make([]string, 0, len(launch.Env))
	for key, value := range launch.Env {
		env = append(env, key+"="+value)
	}
	sort.Strings(env)
	info, err := s.shellHub().OpenWith(dir, shellterm.Options{
		Title:   provider.Name,
		Agent:   agentID,
		Key:     "tui:" + sessionName,
		Command: launch.Command,
		Env:     env,
	})
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if creating {
		s.sessionMetaSet(sessionName, map[string]any{"tuiStarted": true})
	}
	writeOK(w, http.StatusOK, struct {
		shellterm.Info
		SessionName string `json:"sessionName"`
	}{info, sessionName})
}

func (s *Controller) shellTerminalClose(w http.ResponseWriter, r *http.Request) {
	if !s.shellHub().Close(r.PathValue("id")) {
		writeFail(w, http.StatusNotFound, "终端不存在")
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"closed": true})
}

func (s *Controller) shellTerminalStream(w http.ResponseWriter, r *http.Request) {
	session, ok := s.shellHub().Get(r.PathValue("id"))
	if !ok {
		writeFail(w, http.StatusNotFound, "终端不存在")
		return
	}
	mirror, err := session.Mirror()
	if err != nil {
		writeFail(w, http.StatusGone, "终端已关闭")
		return
	}
	defer mirror.Close()
	conn, err := shellTermUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.WriteJSON(map[string]any{"type": "status", "session": session.Info()})

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	go func() {
		defer finish()
		conn.SetReadLimit(1 << 20)
		for {
			kind, data, readErr := conn.ReadMessage()
			if readErr != nil {
				return
			}
			switch kind {
			case websocket.BinaryMessage:
				if writeErr := session.Write(data); writeErr != nil {
					return
				}
			case websocket.TextMessage:
				var payload struct {
					Type  string `json:"type"`
					Cols  int    `json:"cols"`
					Rows  int    `json:"rows"`
					CellW int    `json:"cellW"`
					CellH int    `json:"cellH"`
				}
				if json.Unmarshal(data, &payload) != nil {
					continue
				}
				switch payload.Type {
				case "resize":
					_ = session.Resize(payload.Cols, payload.Rows, payload.CellW, payload.CellH)
				case "clear":
					session.Clear()
				}
			}
		}
	}()

	ticker := time.NewTicker(16 * time.Millisecond)
	defer ticker.Stop()
	statusAt := time.Now()
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-ticker.C:
			frame, _ := mirror.Frame()
			if len(frame) > 0 {
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
					return
				}
			}
			if time.Since(statusAt) > time.Second {
				statusAt = time.Now()
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if err := conn.WriteJSON(map[string]any{"type": "status", "session": session.Info()}); err != nil {
					return
				}
			}
		}
	}
}

func (s *Controller) shellProjectKey() string {
	if s.agent != nil && s.agent.App() != "" {
		return s.agent.App()
	}
	return s.workspaceRoot()
}

var shellTermUpgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

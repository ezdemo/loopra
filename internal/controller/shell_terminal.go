package controller

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
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
	info, err := s.shellHub().Open(dir)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, info)
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

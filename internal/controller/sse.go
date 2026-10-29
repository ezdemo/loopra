package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// sseWriter 按 Loopra 的精确线协议格式发送帧：
// "event: <type>\ndata: <json>\n\n"。写入失败会被静默忽略并关闭
// 流，以便智能体继续运行，与 Java 的 emitter 保持一致。
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	closed  bool
	mu      sync.Mutex
}

func newSSEWriter(w http.ResponseWriter) *sseWriter {
	flusher, _ := w.(http.Flusher)
	return &sseWriter{w: w, flusher: flusher}
}

// startSSE 写入响应头并返回该 writer。
func startSSE(w http.ResponseWriter) *sseWriter {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	return newSSEWriter(w)
}

// send 发送一个事件，载荷为 JSON 对象。
func (s *sseWriter) send(event string, payload any) {
	if s == nil {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	s.write(event, data)
}

// sendText 发送一个事件，其载荷是裸 JSON 字符串；
// Java 的 emitter 以这种方式手工转义 content/reasoning token。
func (s *sseWriter) sendText(event, text string) {
	if s == nil {
		return
	}
	data, err := json.Marshal(text)
	if err != nil {
		return
	}
	s.write(event, data)
}

// sendRaw 发送一个已编码的事件载荷（外部 Agent 注入的原生事件）。
func (s *sseWriter) sendRaw(event string, data []byte) {
	if s == nil || len(data) == 0 {
		return
	}
	s.write(event, data)
}

func (s *sseWriter) write(event string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, data); err != nil {
		s.closed = true
		return
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	if event == "done" {
		s.closed = true
	}
}

// sendError 发送 error 事件；Java 侧总会在其后发送 done。
func (s *sseWriter) sendError(message string) {
	logging.Errorf("chat", "%s", message)
	s.send("error", map[string]any{"error": message})
	s.done()
}

// done 用终止事件关闭流。
func (s *sseWriter) done() {
	if s == nil {
		return
	}
	s.send("done", map[string]any{})
}

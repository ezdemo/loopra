package controller

import (
	"sync"

	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

// sseToolResults 把单个工具完成的结果立即写入当前 SSE 流。
//
// ADK 会等一批并行函数调用全部结束后才把它们合并成一个事件交给
// Runner，因此快工具的结果原本要等慢工具一起上报。安装为
// agentpkg.ToolResultSink 后，工具一完成就发 tool_result；
// 合并事件随后到达时按 toolCallId 去重，避免重复。
type sseToolResults struct {
	sse  *sseWriter
	mu   sync.Mutex
	sent map[string]bool
}

func newSSEToolResults(sse *sseWriter) *sseToolResults {
	return &sseToolResults{sse: sse, sent: map[string]bool{}}
}

// ToolFinished 实现 agentpkg.ToolResultSink。
func (r *sseToolResults) ToolFinished(callID, name string, response map[string]any) {
	if callID == "" {
		return
	}
	r.mu.Lock()
	if r.sent[callID] {
		r.mu.Unlock()
		return
	}
	r.sent[callID] = true
	r.mu.Unlock()
	// sseWriter 自带互斥，多个工具并发完成时每帧仍然是完整的。
	r.sse.send("tool_result", map[string]any{
		"toolCallId": callID,
		"name":       name,
		"result":     responseText(response),
		"status":     "completed",
	})
}

// ToolResultSent 实现 agentpkg.ToolResultSink。
func (r *sseToolResults) ToolResultSent(callID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sent[callID]
}

var _ agentpkg.ToolResultSink = (*sseToolResults)(nil)

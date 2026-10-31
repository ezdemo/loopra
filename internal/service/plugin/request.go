package plugin

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

var errPluginBusy = errors.New("等待插件执行时请求已取消")

// PageContext is a snapshot of the workbench selection, not an authorization grant.
type PageContext struct {
	WorkspaceHash string `json:"workspaceHash,omitempty"`
	WorkspaceDir  string `json:"workspaceDir,omitempty"`
	SessionID     string `json:"sessionId,omitempty"`
	FilePath      string `json:"filePath,omitempty"`
}

// Request invokes only this plugin's private page handler. Agent tools remain
// behind their existing approval policy and are never dispatched here.
func (h *Host) Request(ctx context.Context, id, action string, value map[string]any, selection ...PageContext) (any, error) {
	if h == nil {
		return nil, errors.New("插件宿主未初始化")
	}
	if strings.TrimSpace(action) == "" || len(action) > 128 {
		return nil, errors.New("页面操作名称无效")
	}
	h.mu.Lock()
	var run *running
	for _, rec := range h.records {
		if rec.ID == id && rec.Enabled {
			run = h.loaded[id]
			break
		}
	}
	h.mu.Unlock()
	if run == nil {
		return nil, errors.New("请先启用插件")
	}
	config, err := h.UIConfig(id)
	if err != nil {
		return nil, err
	}
	if value == nil {
		value = map[string]any{}
	}
	pageContext := PageContext{}
	if len(selection) > 0 {
		pageContext = selection[0]
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := run.request(ctx, map[string]any{"action": action, "value": value, "config": config, "context": pageContext})
	if err != nil && ctx.Err() != nil && !errors.Is(err, errPluginBusy) {
		// An interrupted event loop retains pending timers and async work. Replace
		// this backend before another request can resume those abandoned tasks.
		h.restartPageBackend(id, run)
	}
	return out, err
}

func (h *Host) restartPageBackend(id string, previous *running) {
	h.op.Lock()
	defer h.op.Unlock()
	h.mu.Lock()
	var current *record
	for _, rec := range h.records {
		if rec.ID == id && rec.Enabled && h.loaded[id] == previous {
			current = &rec
			break
		}
	}
	h.mu.Unlock()
	if current == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.reload(ctx, *current); err != nil {
		logging.Warnf("plugin", "restart %s after cancelled page request: %v", id, err)
	}
}

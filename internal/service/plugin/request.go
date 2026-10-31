package plugin

import (
	"context"
	"errors"
)

// Request serves a plugin page through the host bridge. The HTTP layer still
// authenticates the workbench; the iframe never receives its credentials.
func (h *Host) Request(ctx context.Context, id, action string, value map[string]any) (any, error) {
	if h == nil || h.request == nil {
		return nil, errors.New("插件没有宿主服务")
	}
	h.mu.Lock()
	enabled := false
	for _, rec := range h.records {
		if rec.ID == id {
			enabled = rec.Enabled && h.loaded[id] != nil
			break
		}
	}
	h.mu.Unlock()
	if !enabled {
		return nil, errors.New("请先启用插件")
	}
	return h.request(ctx, id, action, value)
}

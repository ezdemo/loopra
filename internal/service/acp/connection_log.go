package acp

import (
	"context"
	"log/slog"
	"strings"
)

// The SDK exposes Done but not its disconnect cause. Capture its structured
// diagnostic before shutdownReceive wakes pending requests, while forwarding
// every record to the application's existing logger.
type connectionLog struct {
	slog.Handler
	client *Client
}

func (h connectionLog) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= slog.LevelError || h.Handler.Enabled(ctx, level)
}

func (h connectionLog) Handle(ctx context.Context, record slog.Record) error {
	if record.Message == "failed to queue notification; closing connection" || record.Message == "connection closed" {
		record.Attrs(func(attr slog.Attr) bool {
			if (attr.Key == "err" || attr.Key == "cause") && strings.Contains(attr.Value.String(), "notification queue overflow") {
				h.client.mu.Lock()
				h.client.disconnectErr = ErrNotificationOverflow
				h.client.mu.Unlock()
			}
			return true
		})
	}
	if h.Handler.Enabled(ctx, record.Level) {
		return h.Handler.Handle(ctx, record)
	}
	return nil
}

func (h connectionLog) WithAttrs(attrs []slog.Attr) slog.Handler {
	return connectionLog{Handler: h.Handler.WithAttrs(attrs), client: h.client}
}

func (h connectionLog) WithGroup(name string) slog.Handler {
	return connectionLog{Handler: h.Handler.WithGroup(name), client: h.client}
}

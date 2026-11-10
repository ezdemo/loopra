package almarelay

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
)

// HTTP streams preserve the workbench's JSON, binary and SSE bodies verbatim.
// Keeping this writer in the transport means controllers do not know relay frames.
type responseStream struct {
	ctx     context.Context
	header  http.Header
	send    func(frame) error
	id      string
	started bool
	err     error
	bytes   int
}

func (w *responseStream) Header() http.Header { return w.header }
func (w *responseStream) WriteHeader(status int) {
	if w.ctx.Err() != nil {
		w.err = w.ctx.Err()
		return
	}
	if w.started {
		return
	}
	w.started = true
	headers := map[string]string{}
	for _, name := range []string{"Content-Type", "Content-Disposition", "Content-Length", "Cache-Control", "Allow", "Location", "Content-Range", "Accept-Ranges"} {
		if value := w.header.Get(name); value != "" {
			headers[strings.ToLower(name)] = value
		}
	}
	w.err = w.send(frame{Type: "hres", ID: w.id, Status: status, Headers: headers})
}
func (w *responseStream) Write(body []byte) (int, error) {
	if w.ctx.Err() != nil {
		return 0, w.ctx.Err()
	}
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if w.err != nil {
		return 0, w.err
	}
	limit := 16 << 20
	if strings.HasPrefix(w.header.Get("Content-Type"), "text/event-stream") {
		limit = 256 << 20
	}
	if len(body) > limit-w.bytes {
		w.err = errors.New("relay response limit exceeded")
		return 0, w.err
	}
	written := 0
	for len(body) > 0 {
		n := min(len(body), 64<<10)
		if err := w.send(frame{Type: "hchunk", ID: w.id, Body: base64.RawURLEncoding.EncodeToString(body[:n])}); err != nil {
			w.err = err
			return written, err
		}
		written += n
		w.bytes += n
		body = body[n:]
	}
	return written, nil
}
func (w *responseStream) Flush() {
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
}

func (p *phone) serveHTTP(ctx context.Context, handler http.Handler, f frame, body []byte) {
	request, err := http.NewRequestWithContext(ctx, f.Method, f.Path, bytes.NewReader(body))
	if err != nil || request.URL.IsAbs() || request.URL.Host != "" || len(f.Path) > 8192 {
		_ = p.send(frame{Type: "herr", ID: f.ID, Message: "invalid request"})
		return
	}
	for _, name := range []string{"Content-Type", "Accept", "X-Request-ID", "Range"} {
		for key, value := range f.Headers {
			if strings.EqualFold(key, name) {
				request.Header.Set(name, value)
			}
		}
	}
	w := &responseStream{ctx: ctx, header: http.Header{}, id: f.ID, send: p.send}
	handler.ServeHTTP(w, request)
	if ctx.Err() != nil {
		return
	}
	w.Flush()
	if w.err != nil {
		_ = p.send(frame{Type: "herr", ID: f.ID, Message: "response interrupted"})
		return
	}
	_ = p.send(frame{Type: "hend", ID: f.ID})
}

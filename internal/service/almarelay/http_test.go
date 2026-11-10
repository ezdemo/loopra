package almarelay

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMobileHTTPStreamsBeforeHandlerCompletes(t *testing.T) {
	code := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	desktop, client := testSession(t, code)
	frames := make(chan frame, 16)
	p := newPhone(t.Context(), code, nil, func(outer frame) error {
		raw, err := base64.StdEncoding.DecodeString(outer.Body)
		if err != nil {
			return err
		}
		inner, err := client.open(raw)
		if err != nil {
			return err
		}
		frames <- inner
		return nil
	})
	p.session = desktop
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.serveHTTP(t.Context(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Loopra-Key") != "" || r.Header.Get("X-Request-ID") != "request-fixture" {
				t.Error("unexpected forwarded headers")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("event: content\ndata: {\"content\":\"你好\"}\n\n"))
			w.(http.Flusher).Flush()
			<-release
			_, _ = w.Write([]byte("event: done\ndata: {}\n\n"))
		}), frame{ID: "stream", Method: "POST", Path: "/api/chat/stream", Headers: map[string]string{"X-Request-ID": "request-fixture", "X-Loopra-Key": "must-not-forward"}}, nil)
	}()
	t.Cleanup(func() { close(release); <-done; p.close() })
	next := func() frame {
		t.Helper()
		select {
		case value := <-frames:
			return value
		case <-time.After(3 * time.Second):
			t.Fatal("response was buffered instead of streamed")
			return frame{}
		}
	}
	if head := next(); head.Type != "hres" || head.Headers["content-type"] != "text/event-stream" {
		t.Fatal(head)
	}
	chunk := next()
	body, err := base64.RawURLEncoding.DecodeString(chunk.Body)
	if err != nil || chunk.Type != "hchunk" || !strings.Contains(string(body), "你好") {
		t.Fatal(chunk, err)
	}
	select {
	case <-done:
		t.Fatal("handler completed before releasing the stream")
	default:
	}
}

func TestMobileHTTPRejectsExternalTargets(t *testing.T) {
	for _, target := range []string{"https://example.org/api/health", "//example.org/api/health"} {
		called := false
		var result frame
		p := newPhone(context.Background(), "", nil, nil)
		// Invalid targets are rejected before the HTTP handler is reached.
		p.session, _ = testSession(t, base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
		p.outerSend = func(f frame) error { result = f; return nil }
		p.serveHTTP(t.Context(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }), frame{ID: "bad", Method: "GET", Path: target}, nil)
		p.close()
		if called || result.Type != "wmsg" {
			t.Fatal("external target reached the handler")
		}
	}
}

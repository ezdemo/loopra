package provider

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"testing/synctest"
	"time"
)

type wireRoundTripFunc func(*http.Request) (*http.Response, error)

func (f wireRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// 保留生产客户端的超时策略，仅用可被取消的管道代替网络，
// 使 synctest 能即时验证持续数分钟的流式响应。
func stubModelStream(t *testing.T, write func(context.Context, *io.PipeWriter)) {
	t.Helper()
	original := modelStreamHTTPClient
	client := *original
	client.Transport = wireRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		reader, writer := io.Pipe()
		done := make(chan struct{})
		go func() {
			select {
			case <-r.Context().Done():
				writer.CloseWithError(r.Context().Err())
			case <-done:
			}
		}()
		go func() {
			defer close(done)
			defer writer.Close()
			write(r.Context(), writer)
		}()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"text/event-stream"}},
			Body:       reader,
			Request:    r,
		}, nil
	})
	modelStreamHTTPClient = &client
	t.Cleanup(func() { modelStreamHTTPClient = original })
}

func modelStream(t *testing.T, ctx context.Context) *http.Response {
	t.Helper()
	resp, err := postJSON(ctx, nil, http.MethodPost, "https://model.test/stream", nil, map[string]any{"stream": true}, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestModelStreamContinuesBeyondTwoMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stubModelStream(t, func(ctx context.Context, writer *io.PipeWriter) {
			for range 10 {
				time.Sleep(30 * time.Second)
				if _, err := io.WriteString(writer, "data: tick\n\n"); err != nil {
					return
				}
			}
		})
		start := time.Now()
		resp := modelStream(t, context.Background())
		count := 0
		err := readSSE(context.Background(), resp.Body, func(sseEvent) error {
			count++
			return nil
		})
		if err != nil || count != 10 || time.Since(start) != 5*time.Minute {
			t.Fatalf("events=%d elapsed=%s err=%v", count, time.Since(start), err)
		}
	})
}

func TestModelStreamIdleTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stubModelStream(t, func(ctx context.Context, writer *io.PipeWriter) {
			io.WriteString(writer, "data: first\n\n")
			<-ctx.Done()
		})
		start := time.Now()
		resp := modelStream(t, context.Background())
		count := 0
		err := readSSE(context.Background(), resp.Body, func(sseEvent) error {
			count++
			return nil
		})
		var idleErr *responseIdleTimeoutError
		if !errors.As(err, &idleErr) || !errors.Is(err, context.DeadlineExceeded) || !idleErr.Timeout() {
			t.Fatalf("expected idle timeout, got %v", err)
		}
		if count != 1 || time.Since(start) != modelResponseTimeout {
			t.Fatalf("events=%d elapsed=%s", count, time.Since(start))
		}
	})
}

func TestModelStreamCanBeCanceled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stubModelStream(t, func(ctx context.Context, _ *io.PipeWriter) { <-ctx.Done() })
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		resp := modelStream(t, ctx)
		go func() {
			time.Sleep(time.Second)
			cancel()
		}()
		start := time.Now()
		err := readSSE(ctx, resp.Body, func(sseEvent) error { return nil })
		if !errors.Is(err, context.Canceled) || time.Since(start) != time.Second {
			t.Fatalf("elapsed=%s err=%v", time.Since(start), err)
		}
	})
}

func TestModelStreamDoesNotTimeOutWhileHandlingEvents(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stubModelStream(t, func(_ context.Context, writer *io.PipeWriter) {
			io.WriteString(writer, "data: first\n\n")
			io.WriteString(writer, "data: second\n\n")
		})
		resp := modelStream(t, context.Background())
		count := 0
		err := readSSE(context.Background(), resp.Body, func(sseEvent) error {
			count++
			time.Sleep(2 * modelResponseTimeout)
			return nil
		})
		if err != nil || count != 2 {
			t.Fatalf("events=%d err=%v", count, err)
		}
	})
}

func TestModelClientTimeoutPolicy(t *testing.T) {
	for _, stream := range []bool{false, true} {
		client := newModelHTTPClient(stream)
		transport := client.Transport.(*http.Transport)
		if transport.ResponseHeaderTimeout != modelResponseTimeout || transport.DialContext == nil || transport.TLSHandshakeTimeout <= 0 {
			t.Fatalf("missing connection/header timeouts: %+v", transport)
		}
		if stream && client.Timeout != 0 {
			t.Fatal("streaming client must not have a total request timeout")
		}
		if !stream && client.Timeout != modelResponseTimeout {
			t.Fatal("non-streaming client must retain its total request timeout")
		}
	}
}

package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

const maxResponseBytes = 4 << 20

// logModelCall 记录一次模型请求的协议、模型、流式开关与耗时。
func logModelCall(protocol string, start time.Time, model string, stream bool, err error) {
	elapsed := time.Since(start).Round(time.Millisecond)
	if err != nil {
		logging.Errorf("model", "%s model=%s stream=%v failed after %s: %v", protocol, model, stream, elapsed, err)
		return
	}
	logging.Debugf("model", "%s model=%s stream=%v in %s", protocol, model, stream, elapsed)
}

// httpError 表示模型端点返回了非 2xx 响应。
type httpError struct {
	StatusCode int
	Endpoint   string
	Body       string
}

func (e *httpError) Error() string {
	detail := e.Body
	if len(detail) > 2048 {
		detail = detail[:2048]
	}
	return fmt.Sprintf("%s HTTP %d: %s", e.Endpoint, e.StatusCode, detail)
}

// postJSON 携带给定请求头发送 JSON 请求体，并强制统一
// 响应大小限制。非 2xx 响应以 *httpError 返回，此时
// 响应体已被读取，调用方不得再访问 resp.Body。
func postJSON(ctx context.Context, client *http.Client, method, endpoint string, headers map[string]string, body any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		if strings.EqualFold(key, "Content-Type") {
			continue
		}
		req.Header.Set(key, value)
	}
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call %s: %w", endpoint, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		return nil, &httpError{StatusCode: resp.StatusCode, Endpoint: endpoint, Body: string(data)}
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") && !strings.Contains(ct, "text/event-stream") {
		resp.Body.Close()
		return nil, fmt.Errorf("%s returned unexpected content type %q", endpoint, ct)
	}
	return resp, nil
}

// readBody 最多读取 maxResponseBytes，并上报超限的负载。
func readBody(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return nil, fmt.Errorf("response exceeded size limit")
	}
	return data, nil
}

// headerSnapshot 合并固定的通道请求头与单次请求设置，使
// 热切换选项（会话亲和键等）立即生效。
func headerSnapshot(static map[string]string, extra map[string]string) map[string]string {
	out := make(map[string]string, len(static)+len(extra))
	for k, v := range static {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func corsTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts, _ := newTestServer(t)
	return ts
}

// TestCORSPreflight 校验 Java CrossFilter 的契约：认证之前返回空的 200、
// 回显 origin、回显请求方法、使用显式头列表、
// 不发送 Allow-Credentials。
func TestCORSPreflight(t *testing.T) {
	ts := corsTestServer(t)
	req, err := http.NewRequest(http.MethodOptions, ts.URL+"/api/chat/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	// 故意不设置 X-Loopra-Key：预检请求不会经过过滤器
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("preflight status = %d, want 200 (Java setHandled default)", resp.StatusCode)
	}
	h := resp.Header
	if got := h.Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("allow-origin = %q", got)
	}
	if got := h.Get("Access-Control-Allow-Methods"); got != http.MethodPost {
		t.Fatalf("allow-methods = %q, want echo of request method", got)
	}
	if got := h.Get("Access-Control-Allow-Headers"); !strings.Contains(got, "X-Loopra-Key") {
		t.Fatalf("allow-headers = %q", got)
	}
	if h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("allow-credentials must be absent (allowCredentials false)")
	}
	if h.Get("Access-Control-Max-Age") != "3600" {
		t.Fatalf("max-age = %q", h.Get("Access-Control-Max-Age"))
	}
}

func TestCORSPreflightWithoutOriginStillOk(t *testing.T) {
	// GlobalExceptionFilter 对不带 Origin 的 OPTIONS 请求同样直接短路返回。
	ts := corsTestServer(t)
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/tools", nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestCORSHeadersOnNormalAnd401Responses(t *testing.T) {
	ts := corsTestServer(t)
	// 正常免认证路径
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/system/health", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("allow-origin = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Methods"); got != corsAllowMethods {
		t.Fatalf("allow-methods = %q", got)
	}
	if !containsHeader(resp.Header.Values("Vary"), "Origin") {
		t.Fatalf("vary = %v", resp.Header.Values("Vary"))
	}
	// 401 响应必须保留 CORS 头，以便浏览器展示真实状态码
	req, _ = http.NewRequest(http.MethodGet, ts.URL+"/api/tools", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("X-Loopra-Key", "wrong")
	resp, err = ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("allow-origin on 401 = %q", got)
	}
}

func TestCORSAbsentWithoutOrigin(t *testing.T) {
	ts := corsTestServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/system/health", nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("allow-origin leaked: %q", got)
	}
}

func containsHeader(values []string, want string) bool {
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			if strings.TrimSpace(part) == want {
				return true
			}
		}
	}
	return false
}

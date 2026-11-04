package controller

import (
	"net/http"
	"net/url"
	"testing"
)

// /api/agent/bash-sessions 的面板注册表是进程级的，所有接口都必须按
// sessionName 归属过滤：无归属的会话看不到别人的进程，也不能终止它们。
func TestBashSessionsControllerScopesToSession(t *testing.T) {
	server, key := newTestServer(t)

	// 带会话名的列表只返回该会话的进程（空注册表时为空数组）。
	code, env := call(t, server, http.MethodGet, "/api/agent/bash-sessions?sessionName="+url.QueryEscape("sess-a"), key, nil)
	if code != http.StatusOK {
		t.Fatalf("list status = %d (%v)", code, env)
	}
	if data, ok := env["data"].([]any); !ok || len(data) != 0 {
		t.Fatalf("list data = %v", env["data"])
	}

	// 未知进程的日志与终止都必须失败，且不能泄漏其它会话的条目。
	if code, _ := call(t, server, http.MethodGet, "/api/agent/bash-sessions/log?sessionName=sess-a&sessionId=nope", key, nil); code != http.StatusBadRequest {
		t.Fatalf("log status = %d", code)
	}
	if code, _ := call(t, server, http.MethodPost, "/api/agent/bash-sessions/terminate", key,
		map[string]any{"sessionId": "nope", "sessionName": "sess-a"}); code != http.StatusBadRequest {
		t.Fatalf("terminate status = %d", code)
	}

	// 终止「全部」必须带上会话名，否则会跨会话误杀。
	if code, _ := call(t, server, http.MethodPost, "/api/agent/bash-sessions/terminate", key, map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("unscoped terminate-all status = %d", code)
	}
}

package controller

import (
	"net/http"
	"testing"
)

func TestChatPermissionsEmptyAndStale(t *testing.T) {
	ts, key := newTestServer(t)
	// 列表：没有待处理审批
	_, env := call(t, ts, http.MethodGet, "/api/chat/permissions?workspaceHash=a1b2c3&sessionName=s", key, nil)
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("permissions = %v", env["data"])
	}
	// 缺少 sessionName 被拒绝
	code, _ := call(t, ts, http.MethodGet, "/api/chat/permissions", key, nil)
	if code != http.StatusBadRequest {
		t.Fatal("missing session accepted")
	}
	// 在没有活跃请求时提交决定：返回 409（沿用 Java 的措辞）
	code, env = call(t, ts, http.MethodPost, "/api/chat/permission", key, map[string]string{
		"workspaceHash": "a1b2c3", "sessionName": "s",
		"permissionRequestId": "p1", "optionId": "o1",
	})
	if code != http.StatusConflict || env["error"] != "审批已结束或不属于当前会话" {
		t.Fatalf("submit = %d %v", code, env)
	}
	// 请求体不完整被拒绝
	code, _ = call(t, ts, http.MethodPost, "/api/chat/permission", key, map[string]string{
		"sessionName": "s",
	})
	if code != http.StatusBadRequest {
		t.Fatal("incomplete body accepted")
	}
}

package toolsearch

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
)

// 连接器来源的 Redact 必须把凭据值从 call_tool 的错误文本里抹掉，
// 覆盖原始形式与 URL 查询转义形式。
func TestCallRedactsSourceSecrets(t *testing.T) {
	secret := "top secret&=key"
	failing, err := functiontool.New[struct{}, map[string]any](
		functiontool.Config{Name: "failing", Description: "fails"},
		func(agent.Context, struct{}) (map[string]any, error) {
			return nil, errors.New(`Get "https://x/mcp?key=` + url.QueryEscape(secret) + `": refused; raw ` + secret)
		})
	if err != nil {
		t.Fatal(err)
	}
	set, err := New([]Source{{
		Name:    "amap",
		Toolset: &testToolset{tools: []tool.Tool{failing}},
		Redact: func(text string) string {
			text = strings.ReplaceAll(text, secret, "***")
			return strings.ReplaceAll(text, url.QueryEscape(secret), "***")
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	_, err = set.Call(newTestContext("app", "s"), CallInput{Name: "amap/failing", Arguments: map[string]any{}})
	if err == nil {
		t.Fatal("want error")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), url.QueryEscape(secret)) {
		t.Fatalf("secret leaked: %s", err)
	}
	if !strings.Contains(err.Error(), "***") {
		t.Fatalf("error not redacted: %s", err)
	}
}

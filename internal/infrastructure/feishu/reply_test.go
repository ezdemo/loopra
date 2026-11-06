package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	lark "github.com/larksuite/oapi-sdk-go/v3"
)

type capturedReply struct {
	MsgType string `json:"msg_type"`
	Content string `json:"content"`
}

func replyServer(t *testing.T, code int) (*lark.Client, <-chan capturedReply) {
	t.Helper()
	replies := make(chan capturedReply, 50)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/open-apis/auth/v3/tenant_access_token/internal":
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "tenant_access_token": "test-local-token", "expire": 7200})
		case "/open-apis/im/v1/messages/om-parent/reply":
			var input capturedReply
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Errorf("decode reply: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			replies <- input
			json.NewEncoder(w).Encode(map[string]any{"code": code, "msg": "test response", "data": map[string]any{"message_id": "om-reply"}})
		default:
			t.Errorf("unexpected SDK request: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return lark.NewClient(t.Name(), "test-unused-secret", lark.WithOpenBaseUrl(server.URL), lark.WithHttpClient(server.Client())), replies
}

func markdownText(t *testing.T, reply capturedReply) string {
	t.Helper()
	if reply.MsgType != "post" {
		t.Fatalf("reply type = %q, want post", reply.MsgType)
	}
	var post struct {
		ZhCN struct {
			Content [][]struct {
				Tag  string `json:"tag"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"zh_cn"`
	}
	if err := json.Unmarshal([]byte(reply.Content), &post); err != nil {
		t.Fatal(err)
	}
	if len(post.ZhCN.Content) != 1 || len(post.ZhCN.Content[0]) != 1 || post.ZhCN.Content[0][0].Tag != "md" {
		t.Fatalf("missing native markdown element: %s", reply.Content)
	}
	return post.ZhCN.Content[0][0].Text
}

func TestReplyUsesNativeMarkdownPost(t *testing.T) {
	client, replies := replyServer(t, 0)
	text := "# 检查结果\n\n**已完成**，请查看 `main.go`。\n\n- 列表一\n- [文档](https://example.com)\n\n```go\nfmt.Println(\"你好\")\n```\n\n> 引用"
	if err := replyMarkdown(context.Background(), client, "om-parent", text); err != nil {
		t.Fatal(err)
	}
	if len(replies) != 1 {
		t.Fatalf("sent %d replies", len(replies))
	}
	if actual := markdownText(t, <-replies); actual != text {
		t.Fatalf("Markdown changed during transport:\n%s", actual)
	}
}

func TestLongMarkdownReplyKeepsCodeFencesAndLineOrder(t *testing.T) {
	client, replies := replyServer(t, 0)
	lines := make([]string, 400)
	for i := range lines {
		lines[i] = fmt.Sprintf("fmt.Println(%d, \"中文\")", i)
	}
	if err := replyMarkdown(context.Background(), client, "om-parent", "```go\n"+strings.Join(lines, "\n")+"\n```"); err != nil {
		t.Fatal(err)
	}
	if len(replies) < 2 {
		t.Fatal("long reply was not split")
	}
	var received []string
	for len(replies) > 0 {
		text := markdownText(t, <-replies)
		if !strings.HasPrefix(text, "```go\n") || !strings.HasSuffix(text, "\n```") {
			t.Fatalf("split message has unclosed or lost code fence: %s", text)
		}
		body := strings.TrimSuffix(strings.TrimPrefix(text, "```go\n"), "\n```")
		received = append(received, strings.Split(body, "\n")...)
	}
	if !slices.Equal(received, lines) {
		t.Fatal("split reply lost, repeated or reordered code")
	}
}

func TestMarkdownReplyReportsPlatformFailure(t *testing.T) {
	client, _ := replyServer(t, 230001)
	if err := replyMarkdown(context.Background(), client, "om-parent", "**test**"); err == nil || !strings.Contains(err.Error(), "230001") {
		t.Fatalf("platform error was lost: %v", err)
	}
}

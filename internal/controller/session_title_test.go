package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func TestChatGeneratesAndPreservesTitle(t *testing.T) {
	ts, key := newTestServer(t)
	for i, message := range []string{"整理模型配置", "继续检查"} {
		body, _ := json.Marshal(map[string]any{"message": message, "sessionName": "loopra-title"})
		req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream", strings.NewReader(string(body)))
		req.Header.Set("X-Loopra-Key", key)
		response, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		events := parseSSE(t, readAll(t, response))
		response.Body.Close()
		for _, event := range events {
			if event["type"] == "error" {
				t.Fatalf("chat failed: %v", event)
			}
		}
		_, status := call(t, ts, "GET", "/api/agent/session-status?sessionName=loopra-title", key, nil)
		want := "整理模型配置"
		if i > 0 {
			want = "自定义标题"
		}
		if status["data"].(map[string]any)["title"] != want {
			t.Fatalf("status = %v, want title %q", status, want)
		}
		if i == 0 {
			call(t, ts, "PUT", "/api/sessions/loopra-title/title", key, map[string]any{"title": "自定义标题"})
		}
	}
	_, list := call(t, ts, "GET", "/api/sessions", key, nil)
	if list["data"].([]any)[0].(map[string]any)["title"] != "自定义标题" {
		t.Fatalf("list = %v", list)
	}
}

func TestSessionTitleFallbacks(t *testing.T) {
	cfg := config.Default()
	cfg.WorkspaceDir = t.TempDir()
	a, err := agentpkg.New(t.TempDir(), "__loopra_chat__", &cfg, agentpkg.Options{Model: echo.New("title-test")})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tests := []struct {
		name, content, want string
	}{
		{"loopra-empty", "", "新会话"},
		{"loopra-long", strings.Repeat("标题", 20), strings.Repeat("标题", 15) + "..."},
		{"loopra-context", "```折叠块\n文件与技能上下文\n```\n\n修复  \n 标题", "修复 标题"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.sessionDisplayTitle(test.name, nil); got != "新会话" {
				t.Fatalf("empty session title = %q", got)
			}
			s.ensureSessionTitle(context.Background(), test.name, test.content)
			if got := s.sessionMetaRead(test.name)["title"]; got != test.want {
				t.Fatalf("persisted title = %q, want %q", got, test.want)
			}
		})
	}
	// Legacy sessions can display a title without rewriting their history or metadata.
	history := []map[string]any{
		{"role": "assistant", "content": "忽略回复"},
		{"role": "user", "content": []any{
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AA=="}},
			map[string]any{"type": "text", "text": "分析这张图片"},
		}},
		{"role": "user", "content": "下一条消息"},
	}
	if got := s.sessionDisplayTitle("loopra-legacy", history); got != "分析这张图片" {
		t.Fatalf("legacy title = %q", got)
	}
	if len(s.sessionMetaRead("loopra-legacy")) != 0 {
		t.Fatal("displaying a legacy title wrote metadata")
	}
	session, err := a.Session(context.Background(), "loopra-restored")
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range a.Run(context.Background(), session, userContent("第一条问题", nil)) {
		if err != nil {
			t.Fatal(err)
		}
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	for _, path := range []string{"/api/sessions", "/api/agent/session-status?sessionName=loopra-restored"} {
		_, response := call(t, ts, "GET", path, key, nil)
		var title any
		if path == "/api/sessions" {
			title = response["data"].([]any)[0].(map[string]any)["title"]
		} else {
			title = response["data"].(map[string]any)["title"]
		}
		if title != "第一条问题" {
			t.Fatalf("%s title = %v", path, title)
		}
	}
	if _, err := os.Stat(s.sessionMetaPath("loopra-restored")); !os.IsNotExist(err) {
		t.Fatalf("reading legacy session changed metadata: %v", err)
	}
	s.ensureSessionTitle(context.Background(), "loopra-restored", "后续问题")
	if got := s.sessionMetaRead("loopra-restored")["title"]; got != "第一条问题" {
		t.Fatalf("restored title = %v", got)
	}
}

func TestSessionTitleToolModel(t *testing.T) {
	for _, mode := range []string{"success", "error", "empty", "rename"} {
		t.Run(mode, func(t *testing.T) {
			var s *Controller
			requests := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["model"] != "title-model" || body["stream"] != false || body["tools"] != nil {
					t.Errorf("title request = %v", body)
				}
				raw, _ := json.Marshal(body)
				if strings.Contains(string(raw), "chat-model") {
					t.Error("title request used chat configuration")
				}
				if mode == "error" {
					http.Error(w, "offline", http.StatusServiceUnavailable)
					return
				}
				if mode == "rename" {
					s.sessionMetaSet("loopra-test", map[string]any{"title": "用户命名"})
				}
				text := " “整理模型设置” "
				if mode == "empty" {
					text = " "
				}
				writeJSON(w, 200, map[string]any{"choices": []any{map[string]any{
					"message":       map[string]any{"role": "assistant", "content": text},
					"finish_reason": "stop",
				}}})
			}))
			defer provider.Close()
			cfg := config.Default()
			cfg.WorkspaceDir = t.TempDir()
			cfg.Model = "chat-model"
			cfg.ToolModel, cfg.ToolModelChannelID = "title-model", "title-channel"
			cfg.ModelChannels = append(cfg.ModelChannels, config.Channel{
				ID: "title-channel", BaseURL: provider.URL + "/v1", APIKey: "test",
				Models: []config.ModelEntry{{Name: "title-model"}},
			})
			a, err := agentpkg.New(t.TempDir(), "workspace", &cfg, agentpkg.Options{Model: echo.New("chat-model")})
			if err != nil {
				t.Fatal(err)
			}
			s, _, err = New(a, Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			s.sessionMetaSet("loopra-test", map[string]any{"unknownSetting": true})
			s.ensureSessionTitle(context.Background(), "loopra-test", "调整模型配置")
			want := "整理模型设置"
			switch mode {
			case "error", "empty":
				want = "调整模型配置"
			case "rename":
				want = "用户命名"
			}
			meta := s.sessionMetaRead("loopra-test")
			if meta["title"] != want || meta["unknownSetting"] != true {
				t.Fatalf("metadata = %v, want title %q", meta, want)
			}
			s.ensureSessionTitle(context.Background(), "loopra-test", "后续消息")
			if requests != 1 || s.agent.Model.Name() != "chat-model" {
				t.Fatalf("requests = %d, chat model = %s", requests, s.agent.Model.Name())
			}
		})
	}
}

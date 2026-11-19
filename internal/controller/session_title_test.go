package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
	for _, mode := range []string{"success", "error", "empty", "rename", "delete", "close"} {
		t.Run(mode, func(t *testing.T) {
			const name, fallback = "loopra-test", "调整模型配置"
			var requests atomic.Int32
			started, release, canceled := make(chan struct{}), make(chan struct{}), make(chan struct{})
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count := requests.Add(1)
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
				if count == 1 {
					close(started)
				}
				select {
				case <-r.Context().Done():
					if count == 1 {
						close(canceled)
					}
					return
				case <-release:
				}
				if mode == "error" {
					http.Error(w, "offline", http.StatusServiceUnavailable)
					return
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
			a, err := agentpkg.New(t.TempDir(), "workspace", &cfg, agentpkg.Options{Model: echo.New("chat-model", echo.Script{Text: "main response"})})
			if err != nil {
				t.Fatal(err)
			}
			s, key, err := New(a, Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			s.sessionMetaSet(name, map[string]any{"unknownSetting": true})
			send := func(message string) {
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				payload, err := json.Marshal(map[string]any{"message": message, "sessionName": name})
				if err != nil {
					t.Fatal(err)
				}
				req, err := http.NewRequestWithContext(ctx, "POST", ts.URL+"/api/chat/stream", strings.NewReader(string(payload)))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("X-Loopra-Key", key)
				response, err := ts.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				raw, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				events := parseSSE(t, string(raw))
				content, complete := false, false
				for _, event := range events {
					switch event["type"] {
					case "content":
						content = true
					case "complete":
						complete = true
					case "error":
						t.Fatalf("chat failed: %v", event)
					}
				}
				if !content || !complete || !strings.Contains(string(raw), "main response") {
					t.Fatalf("chat events = %v, body = %s", eventTypes(events), raw)
				}
			}
			assertStatus := func(want string) {
				_, status := call(t, ts, "GET", "/api/agent/session-status?sessionName="+name, key, nil)
				data, _ := status["data"].(map[string]any)
				if data["running"] != false || data["title"] != want {
					t.Fatalf("status = %v, want title %q", status, want)
				}
			}
			send(fallback)
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("title request did not reach the provider")
			}
			// 生成请求还压在 provider 闸门口，首轮标题已是首条消息摘要。
			assertStatus(fallback)
			if mode == "success" {
				// 后续轮次不等待也不重新调度标题任务。
				send("后续消息")
			}
			want := "整理模型设置"
			switch mode {
			case "error", "empty", "rename", "close":
				want = fallback
			}
			switch mode {
			case "rename":
				code, _ := call(t, ts, "PUT", "/api/sessions/"+name+"/title", key, map[string]any{"title": fallback})
				if code != http.StatusOK {
					t.Fatalf("rename status = %d", code)
				}
			case "delete":
				code, _ := call(t, ts, "DELETE", "/api/sessions/"+name, key, nil)
				if code != http.StatusOK {
					t.Fatalf("delete status = %d", code)
				}
			case "close":
				if err := s.Close(); err != nil {
					t.Fatalf("close = %v", err)
				}
			}
			if mode == "rename" || mode == "delete" || mode == "close" {
				select {
				case <-canceled:
				case <-time.After(5 * time.Second):
					t.Fatal("title request context was not canceled")
				}
			}
			unblock()
			s.state.titleJobsWG.Wait()
			if got := requests.Load(); got != 1 {
				t.Fatalf("requests = %d, want 1", got)
			}
			if mode == "delete" {
				if _, err := os.Stat(s.sessionMetaPath(name)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("metadata after delete: %v", err)
				}
				return
			}
			assertStatus(want)
			meta := s.sessionMetaRead(name)
			if meta["title"] != want || meta["unknownSetting"] != true {
				t.Fatalf("metadata = %v, want title %q", meta, want)
			}
		})
	}
}

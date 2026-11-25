package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
)

// TestToolModelConfigAliases 校验旧客户端的 validationModel 字段仍作为
// 工具模型的兼容别名读写同一份配置。
func TestToolModelConfigAliases(t *testing.T) {
	ts, key := newTestServer(t)

	status, _ := call(t, ts, http.MethodPut, "/api/config", key, map[string]any{
		"validationModel": "legacy", "validationModelChannelId": "old",
	})
	if status != http.StatusOK {
		t.Fatalf("legacy PUT status = %d", status)
	}
	assertPair := func(model, channel string) {
		t.Helper()
		status, envelope := call(t, ts, http.MethodGet, "/api/config", key, nil)
		if status != http.StatusOK {
			t.Fatalf("GET status = %d", status)
		}
		data, _ := envelope["data"].(map[string]any)
		for field, want := range map[string]string{
			"toolModel": model, "toolModelChannelId": channel,
			"validationModel": model, "validationModelChannelId": channel,
		} {
			if data[field] != want {
				t.Fatalf("%s = %v, want %q", field, data[field], want)
			}
		}
	}
	assertPair("legacy", "old")

	status, _ = call(t, ts, http.MethodPut, "/api/config", key, map[string]any{
		"toolModel": "helper", "toolModelChannelId": "new",
		"validationModel": "legacy", "validationModelChannelId": "old",
	})
	if status != http.StatusOK {
		t.Fatalf("mixed PUT status = %d", status)
	}
	assertPair("helper", "new")

	status, _ = call(t, ts, http.MethodPut, "/api/config", key, map[string]any{"toolModel": "", "toolModelChannelId": ""})
	if status != http.StatusOK {
		t.Fatalf("clear PUT status = %d", status)
	}
	status, _ = call(t, ts, http.MethodPut, "/api/config", key, map[string]any{"lang": "EN"})
	if status != http.StatusOK {
		t.Fatalf("unrelated PUT status = %d", status)
	}
	assertPair("", "")
}

// TestToolModelUsedForTitleAndReview 验证会话标题与 auto 预审都走同一个
// 工具模型渠道，清空后两条路径都不发请求。
func TestToolModelUsedForTitleAndReview(t *testing.T) {
	var requests int32
	var mu sync.Mutex
	var models []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		models = append(models, body.Model)
		mu.Unlock()
		text := "Generated title"
		if atomic.AddInt32(&requests, 1) > 1 {
			text = `{"allow":true,"requiresHuman":false,"reason":"ok"}`
		}
		writeJSON(w, http.StatusOK, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": text}, "finish_reason": "stop"}}})
	}))
	defer server.Close()

	cfg := config.Default()
	cfg.Model = "chat-model"
	cfg.WorkspaceDir = t.TempDir()
	cfg.ToolModel, cfg.ToolModelChannelID = "helper", "helpers"
	cfg.ModelChannels = append(cfg.ModelChannels, config.Channel{
		ID: "helpers", Name: "Helpers", BaseURL: server.URL + "/v1", APIKey: "fixture-key", APIProtocol: "chat_completions",
		Models: []config.ModelEntry{{Name: "helper", ContextTokens: -1, MaxTokens: -1}},
	})

	if title := generateSessionTitle(t.Context(), &cfg, "input"); title != "Generated title" {
		t.Fatalf("title = %q", title)
	}
	s := &Controller{cfg: &cfg}
	review := s.buildAIReviewer()
	if review == nil {
		t.Fatal("expected tool model reviewer")
	}
	allow, human, err := review("session", "bash", map[string]any{"command": "ls"})
	if err != nil || !allow || human {
		t.Fatalf("review = %v %v %v", allow, human, err)
	}
	mu.Lock()
	for _, name := range models {
		if name != "helper" {
			t.Fatalf("model = %q, want helper", name)
		}
	}
	mu.Unlock()

	before := atomic.LoadInt32(&requests)
	cfg.ToolModel, cfg.ToolModelChannelID = "", ""
	if title := generateSessionTitle(t.Context(), &cfg, "input"); title != "" {
		t.Fatalf("title after clear = %q", title)
	}
	if reviewer := s.buildAIReviewer(); reviewer != nil {
		t.Fatal("expected nil reviewer after clear")
	}
	if got := atomic.LoadInt32(&requests); got != before {
		t.Fatalf("requests = %d, want %d", got, before)
	}
}

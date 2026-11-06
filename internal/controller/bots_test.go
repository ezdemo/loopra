package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/bot"
	"github.com/ezdemo/looprax/internal/service/projectlinks"
	"google.golang.org/genai"
)

type botTestProvider struct{ grant chan struct{} }

func (p botTestProvider) Register(ctx context.Context, _, _ string, qr func(string, int)) (model.BotCredentials, error) {
	qr("https://accounts.feishu.cn/loopra-test", 600)
	select {
	case <-p.grant:
		return model.BotCredentials{AppID: "cli-test", AppSecret: "test-only-secret", OwnerID: "ou-owner"}, nil
	case <-ctx.Done():
		return model.BotCredentials{}, ctx.Err()
	}
}
func (p botTestProvider) Connect(ctx context.Context, _ model.Bot, _ func(context.Context, model.BotMessage, func(context.Context, string) error) error, state func(string)) error {
	state("connected")
	<-ctx.Done()
	return ctx.Err()
}

func botServer(t *testing.T) (*Controller, *httptest.Server, string, chan struct{}) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("LOOPRA_AGENTS_SKILLS_DIR", filepath.Join(home, "skills"))
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", "")
	cfg := config.Default()
	cfg.WorkspaceDir = filepath.Join(home, "original")
	a, err := agentpkg.New(home, service.WorkspaceHash(cfg.WorkspaceDir), &cfg, agentpkg.Options{Model: echo.New("bot-echo")})
	if err != nil {
		t.Fatal(err)
	}
	grant := make(chan struct{})
	bots, err := bot.New(repository.NewBotRepository(home), botTestProvider{grant})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Home: home, Bots: bots})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { _ = s.Close(); ts.Close() })
	return s, ts, key, grant
}

func pollBotRegistration(t *testing.T, ts *httptest.Server, key, id, state string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		code, env := call(t, ts, http.MethodGet, "/api/bots/registrations/"+id, key, nil)
		if code != http.StatusOK {
			t.Fatalf("registration poll = %d %v", code, env)
		}
		reg := env["data"].(map[string]any)
		if reg["state"] == state {
			return reg
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("registration did not reach " + state)
	return nil
}

func TestBotAPIRegistrationCRUDAndProjectPreservation(t *testing.T) {
	s, ts, key, grant := botServer(t)
	original := s.configSnapshot().WorkspaceDir
	if code, _ := call(t, ts, http.MethodGet, "/api/bots", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("missing access key = %d", code)
	}
	request, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/bots", nil)
	request.Header.Set("X-Loopra-Key", key)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != "GET, HEAD" {
		t.Fatalf("unsupported method = %d Allow=%s", response.StatusCode, response.Header.Get("Allow"))
	}
	code, env := call(t, ts, http.MethodPost, "/api/bots/registrations", key, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("begin = %d %v", code, env)
	}
	id := env["data"].(map[string]any)["id"].(string)
	waiting := pollBotRegistration(t, ts, key, id, "waiting")
	if !strings.HasPrefix(waiting["qrCode"].(string), "data:image/png;base64,") || len(s.projectList()) != 1 {
		t.Fatal("QR missing or project created before authorization")
	}
	close(grant)
	pollBotRegistration(t, ts, key, id, "completed")
	_, env = call(t, ts, http.MethodGet, "/api/bots", key, nil)
	data, _ := json.Marshal(env)
	if strings.Contains(string(data), "test-only-secret") || strings.Contains(string(data), "appSecret") {
		t.Fatal("credentials exposed by list")
	}
	item := env["data"].([]any)[0].(map[string]any)
	hash := item["workspaceHash"].(string)
	if len(s.projectList()) != 2 || s.configSnapshot().WorkspaceDir != original {
		t.Fatal("Bot project was not created independently")
	}
	_, env = call(t, ts, http.MethodPut, "/api/workspaces/"+hash+"/name", key, map[string]any{"displayName": "我的机器人"})
	if env["success"] != true {
		t.Fatalf("rename project = %v", env)
	}
	_, env = call(t, ts, http.MethodPut, "/api/bots/"+id, key, map[string]any{"name": "助手", "enabled": false})
	if env["success"] != true || env["data"].(map[string]any)["workspaceHash"] != hash {
		t.Fatalf("update = %v", env)
	}
	reply, err := s.RunBotTurn(context.Background(), hash, "bot-preserved", "hello")
	if err != nil || reply != "hello" {
		t.Fatalf("turn = %q %v", reply, err)
	}
	code, env = call(t, ts, http.MethodDelete, "/api/bots/"+id, key, nil)
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("delete = %d %v", code, env)
	}
	for _, name := range []string{"workspace.json", filepath.Join("sessions", "bot-preserved.jsonl")} {
		if _, err := os.Stat(filepath.Join(s.home, "workspace", hash, name)); err != nil {
			t.Fatalf("delete removed project or history: %v", err)
		}
	}
}

func TestBotTurnCanWriteToMultipleLinkedProjects(t *testing.T) {
	s, _, _, _ := botServer(t)
	hash, err := s.PrepareBotProject(context.Background(), "0123456789abcdef01234567")
	if err != nil {
		t.Fatal(err)
	}
	var linked []string
	var calls []*genai.FunctionCall
	for _, name := range []string{"project-a", "project-b"} {
		path := filepath.Join(s.home, name)
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
		linked = append(linked, path)
		calls = append(calls, &genai.FunctionCall{Name: "write", Args: map[string]any{"path": filepath.Join(path, "result.txt"), "content": name}})
	}
	if err := projectlinks.New(s.home, &s.state.files).Save(hash, nil, linked); err != nil {
		t.Fatal(err)
	}
	if err := s.saveConfig(map[string]any{"toolsRestrictWorkspace": true, "hitl": "free"}); err != nil {
		t.Fatal(err)
	}
	cfg := s.configSnapshot()
	// 派生工作区继续复用根 Agent 的测试模型，不需要网络或付费模型。
	a, err := agentpkg.New(s.home, s.agent.App(), cfg, agentpkg.Options{Model: echo.New("bot-write", echo.Script{ToolCalls: calls}, echo.Script{Text: "done"})})
	if err != nil {
		t.Fatal(err)
	}
	s.state.mu.Lock()
	s.agent = a
	s.state.mu.Unlock()
	reply, err := s.RunBotTurn(context.Background(), hash, "multi-project", "update both")
	if err != nil || reply != "done" {
		t.Fatalf("bot turn = %q %v", reply, err)
	}
	for _, path := range linked {
		data, err := os.ReadFile(filepath.Join(path, "result.txt"))
		if err != nil || string(data) != filepath.Base(path) {
			t.Fatalf("linked project was not writable: %s %q %v", path, data, err)
		}
	}
}

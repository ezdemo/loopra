package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func subServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	registry := tools.NewRegistry(tools.FileTools(ws)...)
	a, err := agentpkg.New(home, "sub0000001", &cfg, agentpkg.Options{
		Toolsets: []tool.Toolset{registry},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home, Registry: registry})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, home
}

func TestSubAgentsListAndMerge(t *testing.T) {
	ts, key, home := subServer(t)
	code, env := call(t, ts, http.MethodGet, "/api/sub-agents", key, nil)
	if code != http.StatusOK {
		t.Fatalf("list: %d %v", code, env)
	}
	list := env["data"].([]any)
	if len(list) != 5 {
		t.Fatalf("builtin count = %d", len(list))
	}
	byID := map[string]map[string]any{}
	for _, item := range list {
		dto := item.(map[string]any)
		byID[dto["id"].(string)] = dto
	}
	if byID["explore"]["readOnly"] != true || byID["explore"]["builtin"] != true {
		t.Fatalf("explore dto = %v", byID["explore"])
	}
	if byID["implement"]["readOnly"] != false {
		t.Fatalf("implement dto = %v", byID["implement"])
	}
	// explore cannot access write tools, including the platform's shell tool.
	for _, name := range byID["explore"]["tools"].([]any) {
		if name == "write" || name == "edit" || name == shellenv.Current.Name {
			t.Fatalf("write tool leaked into read-only profile: %v", byID["explore"]["tools"])
		}
	}
	// 首次访问时创建文件
	if _, err := os.Stat(filepath.Join(home, "sub-agents.json")); err != nil {
		t.Fatalf("sub-agents.json missing: %v", err)
	}
	// denied-tools 返回常量列表
	_, env = call(t, ts, http.MethodGet, "/api/sub-agents/denied-tools", key, nil)
	if got := len(env["data"].([]any)); got != 12 {
		t.Fatalf("denied count = %d", got)
	}
}

func TestSubAgentsPutValidationAndBuiltinRestore(t *testing.T) {
	ts, key, home := subServer(t)
	// 重复 id 被拒绝
	code, env := call(t, ts, http.MethodPut, "/api/sub-agents", key,
		map[string]any{"profiles": []map[string]any{
			{"id": "x1", "name": "A"}, {"id": "x1", "name": "B"},
		}})
	if code != http.StatusBadRequest || env["success"] != false {
		t.Fatalf("duplicate: %d %v", code, env)
	}
	// 空 id 被拒绝
	code, _ = call(t, ts, http.MethodPut, "/api/sub-agents", key,
		map[string]any{"profiles": []map[string]any{{"id": " ", "name": "A"}}})
	if code != http.StatusBadRequest {
		t.Fatalf("empty id accepted")
	}
	// 保存一个被篡改的内置角色和一个自定义角色
	_, env = call(t, ts, http.MethodPut, "/api/sub-agents", key,
		map[string]any{"profiles": []map[string]any{
			{"id": "EXPLORE", "name": "hacked", "enable": false},
			{"id": "custom1", "name": "Custom", "description": "mine",
				"instructions": "do things", "readOnly": true},
		}})
	if env["success"] != true {
		t.Fatalf("put: %v", env)
	}
	byID := map[string]map[string]any{}
	for _, item := range env["data"].([]any) {
		dto := item.(map[string]any)
		byID[dto["id"].(string)] = dto
	}
	// 内置内容已还原，enable 保留，id 归一为小写
	if byID["explore"]["name"] != "探索" {
		t.Fatalf("builtin name not restored: %v", byID["explore"]["name"])
	}
	if byID["explore"]["enable"] != false {
		t.Fatalf("enable not preserved: %v", byID["explore"]["enable"])
	}
	if _, ok := byID["custom1"]; !ok {
		t.Fatalf("custom profile lost: %v", byID)
	}
	// 按保存内容原样落盘（合并前为 2 条）
	data, err := os.ReadFile(filepath.Join(home, "sub-agents.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Profiles []map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	// 落盘内容：2 条已保存条目加上还原的 4 个内置角色
	if len(file.Profiles) != 6 {
		t.Fatalf("file profiles = %d", len(file.Profiles))
	}
}

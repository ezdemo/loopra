package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func mcpServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "mcp0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, home
}

func TestMcpServersCRUD(t *testing.T) {
	ts, key, home := mcpServer(t)
	// 初始列表为空
	_, env := call(t, ts, http.MethodGet, "/api/mcp/servers", key, nil)
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("initial = %d", got)
	}
	// 新增（enabled 默认为 true）
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/add", key,
		map[string]any{"name": "fs", "type": "stdio", "command": "npx", "args": []string{"-y", "@mcp/fs"}})
	server := env["data"].(map[string]any)
	if server["enabled"] != true {
		t.Fatalf("add = %v", server)
	}
	// 通过带 originalName 的 update 重命名
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/update", key,
		map[string]any{"originalName": "fs", "server": map[string]any{
			"name": "filesystem", "type": "stdio", "command": "npx"}})
	if env["data"].(map[string]any)["name"] != "filesystem" {
		t.Fatalf("update = %v", env["data"])
	}
	_, env = call(t, ts, http.MethodGet, "/api/mcp/servers", key, nil)
	if got := len(env["data"].([]any)); got != 1 {
		t.Fatalf("after rename = %v", env["data"])
	}
	// 关闭开关
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/toggle", key,
		map[string]any{"name": "filesystem", "enabled": false})
	if env["data"].(map[string]any)["enabled"] != false {
		t.Fatalf("toggle = %v", env["data"])
	}
	// 更新未知名称被拒绝
	code, _ := call(t, ts, http.MethodPost, "/api/mcp/servers/update", key,
		map[string]any{"originalName": "ghost", "server": map[string]any{"name": "g", "type": "stdio", "command": "x"}})
	if code != http.StatusBadRequest {
		t.Fatal("ghost update accepted")
	}
	// 删除
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/remove", key,
		map[string]string{"name": "filesystem"})
	if env["data"] != "服务器已删除" {
		t.Fatalf("remove = %v", env)
	}
	// 以原生 servers 数组持久化
	data, _ := os.ReadFile(filepath.Join(home, "mcp-servers.json"))
	if len(data) == 0 {
		t.Fatal("mcp-servers.json never written")
	}
}

func TestMcpJavaFileInteroperability(t *testing.T) {
	// 由 Java/外部工具写入、同时包含两种格式的文件
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	os.MkdirAll(home, 0o755)
	java := `{
  "servers": [
    {"name": "native-one", "type": "stdio", "enabled": true, "command": "npx"}
  ],
  "mcpServers": {
    "remote": {"url": "https://example.com/mcp", "transport": "streamable"},
    "legacy": {"command": "node", "args": ["server.js"]}
  }
}`
	os.WriteFile(filepath.Join(home, "mcp-servers.json"), []byte(java), 0o644)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, _ := agentpkg.New(home, "mcp0000002", &cfg, agentpkg.Options{})
	srv, key, _ := New(a, Options{Home: home})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })

	_, env := call(t, ts, http.MethodGet, "/api/mcp/servers", key, nil)
	list := env["data"].([]any)
	if len(list) != 3 {
		t.Fatalf("merged view = %v", list)
	}
	byName := map[string]map[string]any{}
	for _, item := range list {
		dto := item.(map[string]any)
		byName[dto["name"].(string)] = dto
	}
	// 传输回退：无 type 仅有 url -> streamable
	if byName["remote"]["type"] != "streamable" {
		t.Fatalf("remote = %v", byName["remote"])
	}
	// 有 command 无 url -> stdio
	if byName["legacy"]["type"] != "stdio" {
		t.Fatalf("legacy = %v", byName["legacy"])
	}
	// 在 Go 侧删除外部条目会将其从 mcpServers 中移除
	_, env = call(t, ts, http.MethodPost, "/api/mcp/servers/remove", key,
		map[string]string{"name": "remote"})
	if env["success"] != true {
		t.Fatalf("remove external = %v", env)
	}
	raw, _ := os.ReadFile(filepath.Join(home, "mcp-servers.json"))
	body := string(raw)
	if !strings.Contains(body, "native-one") || !strings.Contains(body, "legacy") {
		t.Fatalf("survivors lost: %s", body)
	}
}

func TestMcpExportConfig(t *testing.T) {
	ts, key, home := mcpServer(t)
	// 默认值
	_, env := call(t, ts, http.MethodGet, "/api/mcp/export", key, nil)
	view := env["data"].(map[string]any)
	if view["name"] != "loopra" || view["enabled"] != false || view["endpoint"] != "/mcp" {
		t.Fatalf("export defaults = %v", view)
	}
	// PUT 持久化
	_, env = call(t, ts, http.MethodPut, "/api/mcp/export", key,
		map[string]any{"enabled": true, "name": "my-loopra", "allowedTools": []string{"read", "rg"}})
	view = env["data"].(map[string]any)
	if view["enabled"] != true || view["name"] != "my-loopra" {
		t.Fatalf("export put = %v", view)
	}
	if _, err := os.Stat(filepath.Join(home, "mcp-server.json")); err != nil {
		t.Fatal("mcp-server.json not written")
	}
	// GET 读回
	_, env = call(t, ts, http.MethodGet, "/api/mcp/export", key, nil)
	view = env["data"].(map[string]any)
	if view["name"] != "my-loopra" {
		t.Fatalf("export readback = %v", view)
	}
}

func TestMcpTunnelStatus(t *testing.T) {
	ts, key, _ := mcpServer(t)
	_, env := call(t, ts, http.MethodGet, "/api/mcp/tunnel", key, nil)
	view := env["data"].(map[string]any)
	if view["running"] != false {
		t.Fatalf("tunnel = %v", view)
	}
	if _, ok := view["installed"]; !ok {
		t.Fatalf("tunnel view = %v", view)
	}
}

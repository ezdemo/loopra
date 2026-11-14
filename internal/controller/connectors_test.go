package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/toolconfirmation"

	"github.com/ezdemo/looprax/internal/service/connector"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/tools"
	"github.com/ezdemo/looprax/internal/service/toolsearch"
)

// newConnectorTestController 返回一个最小装配的 Controller 与
// 指向 httptest MCP 服务的连接器服务。
func newConnectorTestController(t *testing.T, mcpURL string) (*Controller, *connector.Service) {
	t.Helper()
	catalog := connector.Catalog{
		Version:    1,
		Categories: []connector.Category{{ID: "dev", Name: "开发"}},
		Connectors: []connector.Connector{{
			ID: "tok", Name: "令牌服务", Category: "dev",
			Transport: connector.Transport{
				Type:    "streamable",
				URL:     mcpURL,
				Headers: map[string]string{"Authorization": "Bearer {{token}}"},
			},
			Auth: connector.Auth{Type: "token", Fields: []connector.Field{{Key: "token", Secret: true}}},
		}},
	}
	if err := catalog.Validate(); err != nil {
		t.Fatal(err)
	}
	svc := connector.New(catalog, t.TempDir())
	t.Cleanup(svc.Close)
	s := &Controller{home: t.TempDir(), mcp: &mcpStore{}, connectors: svc}
	s.state = newRuntimeState(s)
	return s, svc
}

// newTokenMcpServer 启动要求 Bearer 头的 streamable MCP 假服务。
func newTokenMcpServer(t *testing.T, token string) *httptest.Server {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "fake", Version: "0.0.1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "ping", Description: "ping"},
		func(ctx context.Context, req *mcp.CallToolRequest, args struct{}) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "pong"}}}, nil, nil
		})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(ts.Close)
	return ts
}

func callAPI(t *testing.T, s *Controller, method, path, body string) (int, apiResponse) {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	rec := httptest.NewRecorder()
	s.connectorsController(rec, req)
	var resp apiResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad response %q: %v", rec.Body.String(), err)
	}
	return rec.Code, resp
}

func TestConnectorTokenConnectSuccess(t *testing.T) {
	ts := newTokenMcpServer(t, "good-token")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")

	status, resp := callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"good-token"}}`)
	if status != http.StatusOK || !resp.Success {
		t.Fatalf("connect failed: %d %+v", status, resp)
	}
	data, _ := resp.Data.(map[string]any)
	if data["status"] != "connected" || data["toolCount"].(float64) != 1 {
		t.Fatalf("data = %v", data)
	}
}

func TestConnectorTokenConnectFailure(t *testing.T) {
	ts := newTokenMcpServer(t, "good-token")
	s, svc := newConnectorTestController(t, ts.URL+"/mcp")

	status, _ := callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"bad"}}`)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	if view := svc.View("tok"); view.Connected {
		t.Fatal("failed connect must not persist")
	}
}

func TestConnectorToggleAndDisconnect(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, svc := newConnectorTestController(t, ts.URL+"/mcp")

	callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"any"}}`)
	status, _ := callAPI(t, s, http.MethodPost, "/api/connectors/tok/toggle", `{"enabled":false}`)
	if status != http.StatusOK || svc.View("tok").Enabled {
		t.Fatalf("toggle failed: %d %+v", status, svc.View("tok"))
	}
	status, _ = callAPI(t, s, http.MethodPost, "/api/connectors/tok/disconnect", `{}`)
	if status != http.StatusOK || svc.View("tok").Connected {
		t.Fatalf("disconnect failed: %d %+v", status, svc.View("tok"))
	}
	// 目录条目仍在。
	status, resp := callAPI(t, s, http.MethodGet, "/api/connectors", "")
	if status != http.StatusOK || !resp.Success {
		t.Fatalf("list failed: %d", status)
	}
}

func TestConnectorSessionOverrideAffectsTurnMcpSets(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")

	callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"any"}}`)
	if _, ok := s.connectorMcpServers("sess1")["tok"]; !ok {
		t.Fatal("connected connector missing from turn sources")
	}
	status, _ := callAPI(t, s, http.MethodPut, "/api/connectors/session",
		`{"sessionName":"sess1","id":"tok","enabled":false}`)
	if status != http.StatusOK {
		t.Fatalf("session put failed: %d", status)
	}
	if _, ok := s.connectorMcpServers("sess1")["tok"]; ok {
		t.Fatal("session override should disable connector for that session")
	}
	if _, ok := s.connectorMcpServers("other")["tok"]; !ok {
		t.Fatal("override must not affect other sessions")
	}
	// 会话开关列表。
	_, resp := callAPI(t, s, http.MethodGet, "/api/connectors/session?sessionName=sess1", "")
	entries, _ := resp.Data.([]any)
	if len(entries) != 1 {
		t.Fatalf("session connectors = %v", resp.Data)
	}
	entry := entries[0].(map[string]any)
	if entry["override"] != false || entry["enabled"] != false {
		t.Fatalf("entry = %v", entry)
	}
	// 清除覆盖后恢复全局启用。
	callAPI(t, s, http.MethodPut, "/api/connectors/session",
		`{"sessionName":"sess1","id":"tok","enabled":null}`)
	if _, ok := s.connectorMcpServers("sess1")["tok"]; !ok {
		t.Fatal("clearing override should restore global enabled")
	}
}

func TestChatRequestConnectorsMergeIntoMeta(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")

	callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"any"}}`)
	// 会话级先关掉，请求体携带 enabled=true 应覆盖回来。
	callAPI(t, s, http.MethodPut, "/api/connectors/session",
		`{"sessionName":"s1","id":"tok","enabled":false}`)
	s.mergeRequestConnectors("s1", map[string]bool{"tok": true, "ghost": false})
	if !s.connectorSessionOverrides("s1")["tok"] {
		t.Fatal("request connectors not merged")
	}
	if _, ok := s.connectorSessionOverrides("s1")["ghost"]; ok {
		t.Fatal("unknown connector id merged")
	}
	if _, ok := s.connectorMcpServers("s1")["tok"]; !ok {
		t.Fatal("connector should be enabled for turn after merge")
	}
}

// ---- connector_* 模型侧工具 ----

// connectorToolCtx 是最小的 agent.Context：只有 Value（会话名）
// 与 Done/Err 会被连接器工具用到。
type connectorToolCtx struct {
	agentctx.Context
	base context.Context
}

func newConnectorToolCtx(session string) *connectorToolCtx {
	return &connectorToolCtx{base: context.WithValue(context.Background(), sessionKey{}, session)}
}
func (c *connectorToolCtx) Deadline() (time.Time, bool) { return c.base.Deadline() }
func (c *connectorToolCtx) Done() <-chan struct{}       { return c.base.Done() }
func (c *connectorToolCtx) Err() error                  { return c.base.Err() }
func (c *connectorToolCtx) Value(key any) any           { return c.base.Value(key) }

// functiontool 运行时会读取工具确认上下文。
func (c *connectorToolCtx) ToolConfirmation() *toolconfirmation.ToolConfirmation { return nil }

func installConnectorTestTools(t *testing.T, s *Controller) {
	t.Helper()
	s.registry = tools.NewRegistry()
	s.elicitations = hitl.NewElicitationRegistry()
	s.installConnectorTools()
}

// runnableTool 是 ADK 内部接口；测试里按同样签名断言调用。
type runnableTool interface {
	Run(ctx agentctx.Context, args any) (map[string]any, error)
}

func connectorTool(t *testing.T, s *Controller, name string) runnableTool {
	t.Helper()
	for _, entry := range s.registry.Entries() {
		if entry.Meta.Name == name {
			tl, ok := entry.Tool.(runnableTool)
			if !ok {
				t.Fatalf("tool %s is not runnable", name)
			}
			return tl
		}
	}
	t.Fatalf("tool %s not installed", name)
	return nil
}

func runConnectorTool(t *testing.T, tl runnableTool, ctx agentctx.Context, args map[string]any) map[string]any {
	t.Helper()
	out, err := tl.Run(ctx, args)
	if err != nil {
		t.Fatalf("tool failed: %v", err)
	}
	return out
}

func waitElicitation(t *testing.T, s *Controller, session string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if pending := s.elicitations.Pending(session); len(pending) > 0 {
			return pending[0]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("elicitation never became pending")
	return nil
}

func TestConnectorRequestFastPathWhenEnabled(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	installConnectorTestTools(t, s)
	callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"any"}}`)

	out := runConnectorTool(t, connectorTool(t, s, "connector_request"), newConnectorToolCtx("sess"),
		map[string]any{"connectorId": "tok", "reason": "查天气"})
	if out["connected"] != true || out["note"] != nil {
		t.Fatalf("fast path = %v", out)
	}
	if pending := s.elicitations.Pending("sess"); len(pending) > 0 {
		t.Fatal("fast path must not register an elicitation")
	}
}

func TestConnectorRequestAcceptHotAddsSource(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	installConnectorTestTools(t, s)
	set, err := toolsearch.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { set.Close() })

	tl := connectorTool(t, s, "connector_request")
	ctx := newConnectorToolCtx("sess")
	ctx.base = context.WithValue(ctx.base, turnSetKey{}, set)
	done := make(chan map[string]any, 1)
	go func() {
		out, err := tl.Run(ctx, map[string]any{"connectorId": "tok", "reason": "查天气"})
		if err != nil {
			done <- map[string]any{"toolError": err.Error()}
			return
		}
		done <- out
	}()

	pending := waitElicitation(t, s, "sess")
	marker, _ := pending["schema"].(map[string]any)["x-loopra-connector"].(map[string]any)
	if marker["id"] != "tok" || marker["needs"] != "connect" {
		t.Fatalf("marker = %v", marker)
	}
	// 用户在卡片里完成连接后接受提问。
	if _, err := s.connectors.ConnectCredentials(context.Background(), "tok", map[string]string{"token": "any"}); err != nil {
		t.Fatal(err)
	}
	if err := s.elicitations.Resolve(pending["elicitationRequestId"].(string), "sess", "accept", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	out := <-done
	if out["connected"] != true || out["note"] == nil {
		t.Fatalf("accept result = %v", out)
	}
	// 本轮集合里已经能搜到新源的限定名工具。
	found, err := set.Search(ctx, toolsearch.SearchInput{Query: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Tools) != 1 || found.Tools[0].Name != "tok/ping" || found.Tools[0].Server != "tok" {
		t.Fatalf("hot-added source not searchable: %+v", found)
	}
}

func TestConnectorRequestDeclineAndCancel(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	installConnectorTestTools(t, s)
	tl := connectorTool(t, s, "connector_request")

	for _, tc := range []struct{ name, action string }{{"decline", "decline"}, {"cancel", "cancel"}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := newConnectorToolCtx("sess-" + tc.name)
			done := make(chan map[string]any, 1)
			go func() {
				out, err := tl.Run(ctx, map[string]any{"connectorId": "tok", "reason": "r"})
				if err != nil {
					done <- map[string]any{"toolError": err.Error()}
					return
				}
				done <- out
			}()
			session := "sess-" + tc.name
			pending := waitElicitation(t, s, session)
			if tc.action == "decline" {
				if err := s.elicitations.Resolve(pending["elicitationRequestId"].(string), session, "decline", nil); err != nil {
					t.Fatal(err)
				}
			} else {
				s.elicitations.Cancel(session)
			}
			out := <-done
			if out["connected"] != false {
				t.Fatalf("%s result = %v", tc.name, out)
			}
		})
	}
}

func TestConnectorSetEnabledScopes(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, svc := newConnectorTestController(t, ts.URL+"/mcp")
	installConnectorTestTools(t, s)
	callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"any"}}`)

	tl := connectorTool(t, s, "connector_set_enabled")
	ctx := newConnectorToolCtx("sess")
	out := runConnectorTool(t, tl, ctx, map[string]any{"connectorId": "tok", "enabled": false, "scope": "session"})
	if out["enabled"] != false || out["scope"] != "session" {
		t.Fatalf("session scope = %v", out)
	}
	if s.connectorSessionOverrides("sess")["tok"] != false || svc.View("tok").Enabled != true {
		t.Fatalf("session override wrong: overrides=%v global=%v", s.connectorSessionOverrides("sess"), svc.View("tok"))
	}
	out = runConnectorTool(t, tl, ctx, map[string]any{"connectorId": "tok", "enabled": false, "scope": "global"})
	if out["scope"] != "global" || svc.View("tok").Enabled {
		t.Fatalf("global scope = %v enabled=%v", out, svc.View("tok"))
	}
}

// connector_disconnect 在任何权限模式（含完全自动）都要求确认。
func TestConnectorDisconnectAlwaysRequiresConfirmation(t *testing.T) {
	free := &hitl.Policy{Mode: func() string { return "free" }}
	if !free.Require("sess", "connector_disconnect", nil) {
		t.Fatal("connector_disconnect must require confirmation in free mode")
	}
	if free.Require("sess", "connector_set_enabled", nil) {
		t.Fatal("connector_set_enabled must not be forced in free mode")
	}
}

func TestConnectorListHidesSecrets(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, svc := newConnectorTestController(t, ts.URL+"/mcp")
	installConnectorTestTools(t, s)
	if _, err := svc.ConnectCredentials(context.Background(), "tok", map[string]string{"token": "super-secret"}); err != nil {
		t.Fatal(err)
	}
	out := runConnectorTool(t, connectorTool(t, s, "connector_list"), newConnectorToolCtx("sess"), map[string]any{})
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "super-secret") {
		t.Fatalf("connector_list leaks secret: %s", raw)
	}
	list, _ := out["connectors"].([]any)
	first, _ := list[0].(map[string]any)
	if len(list) != 1 || first["status"] != "connected" || first["enabledForSession"] != true {
		t.Fatalf("list = %v", out)
	}
}

// ---- 自定义 MCP 服务并入连接器体系 ----

func addCustomServer(t *testing.T, s *Controller, server string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/servers/add", strings.NewReader(server))
	s.mcpServers(rec, req, "add")
	if rec.Code != http.StatusOK {
		t.Fatalf("add server: %s", rec.Body.String())
	}
}

func TestConnectorSessionIncludesCustom(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	addCustomServer(t, s, `{"name":"my-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":true}`)
	addCustomServer(t, s, `{"name":"off-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":false}`)

	code, resp := callAPI(t, s, http.MethodGet, "/api/connectors/session?sessionName=sess", "")
	if code != http.StatusOK {
		t.Fatalf("session list: %v", resp)
	}
	items, _ := resp.Data.([]any)
	var found map[string]any
	for _, raw := range items {
		if m, _ := raw.(map[string]any); m["id"] == "my-mcp" {
			found = m
		}
		if m, _ := raw.(map[string]any); m["id"] == "off-mcp" {
			t.Fatalf("globally disabled custom server must not appear: %v", m)
		}
	}
	if found == nil || found["custom"] != true || found["enabled"] != true {
		t.Fatalf("custom entry = %v", found)
	}

	// PUT 接受自定义服务名。
	code, _ = callAPI(t, s, http.MethodPut, "/api/connectors/session", `{"sessionName":"sess","id":"my-mcp","enabled":false}`)
	if code != http.StatusOK {
		t.Fatal("PUT custom name rejected")
	}
	if s.connectorSessionOverrides("sess")["my-mcp"] != false {
		t.Fatal("override not stored")
	}
	// 未知 id 拒绝。
	code, resp = callAPI(t, s, http.MethodPut, "/api/connectors/session", `{"sessionName":"sess","id":"nope","enabled":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("unknown id accepted: %v", resp)
	}
}

func TestCustomSessionOverrideAffectsTurnMcpSets(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	addCustomServer(t, s, `{"name":"my-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":true}`)
	addCustomServer(t, s, `{"name":"off-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":false}`)

	s.sessionMetaUpdate("sess", func(meta map[string]any) {
		meta["connectors"] = map[string]any{"my-mcp": false, "off-mcp": true}
	})
	set, closers := s.turnMcpSets("sess")
	if set == nil {
		t.Fatal("set missing")
	}
	defer func() {
		for _, c := range closers {
			_ = c.Close()
		}
	}()
	found, err := set.Search(newConnectorToolCtx("sess"), toolsearch.SearchInput{Query: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	servers := map[string]bool{}
	for _, tool := range found.Tools {
		servers[tool.Server] = true
	}
	if servers["my-mcp"] {
		t.Fatal("session-disabled custom server must be excluded")
	}
	if !servers["off-mcp"] {
		t.Fatalf("session-enabled custom server must be included: %v", servers)
	}
}

func TestMergeRequestConnectorsAcceptsCustomNames(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	addCustomServer(t, s, `{"name":"my-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":false}`)
	s.mergeRequestConnectors("sess", map[string]bool{"my-mcp": true, "ghost": true})
	overrides := s.connectorSessionOverrides("sess")
	if overrides["my-mcp"] != true {
		t.Fatal("custom name not merged")
	}
	if _, ok := overrides["ghost"]; ok {
		t.Fatal("unknown id must not be merged")
	}
}

func TestCustomProbeAuthRequiredAndOK(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")

	// 无需鉴权的服务 → ok + toolCount。
	code, resp := callAPI(t, s, http.MethodPost, "/api/connectors/custom/probe",
		`{"server":{"name":"p","type":"streamable","url":"`+ts.URL+`/mcp"}}`)
	if code != http.StatusOK {
		t.Fatalf("probe: %v", resp)
	}
	data, _ := resp.Data.(map[string]any)
	if data["ok"] != true || data["toolCount"].(float64) != 1 {
		t.Fatalf("probe result = %v", data)
	}

	// 401 + Bearer 挑战 → authRequired。
	challenge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="https://as.example/prm"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer challenge.Close()
	_, resp = callAPI(t, s, http.MethodPost, "/api/connectors/custom/probe",
		`{"server":{"name":"p","type":"streamable","url":"`+challenge.URL+`/mcp"}}`)
	data, _ = resp.Data.(map[string]any)
	if data["authRequired"] != true {
		t.Fatalf("expected authRequired: %v", data)
	}

	// 普通失败 → ok:false，错误不泄露请求头值。
	dead := httptest.NewServer(http.NotFoundHandler())
	defer dead.Close()
	_, resp = callAPI(t, s, http.MethodPost, "/api/connectors/custom/probe",
		`{"server":{"name":"p","type":"streamable","url":"`+dead.URL+`/mcp","headers":{"Authorization":"Bearer top-secret"}}}`)
	data, _ = resp.Data.(map[string]any)
	raw, _ := json.Marshal(data)
	if data["ok"] != false || strings.Contains(string(raw), "top-secret") {
		t.Fatalf("probe error = %v", data)
	}
}

func TestCustomRenameMovesAndRemoveClearsTokens(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	// 预置一个 custom:old-mcp 授权条目，验证改名迁移与删除清除。
	home := t.TempDir()
	store := `{"connectors":{"custom:old-mcp":{"enabled":true,"status":"connected","oauth":{"clientId":"c","token":{"access_token":"a","refresh_token":"r","token_type":"Bearer"}}}}}`
	if err := os.WriteFile(home+"/connectors.json", []byte(store), 0o600); err != nil {
		t.Fatal(err)
	}
	s, svc := newConnectorTestController(t, ts.URL+"/mcp")
	s.home = home
	_ = svc
	// connectors.Service 用的是自己的 home（t.TempDir），不能看到
	// 预置文件；直接替换为一个指向同一 home 的服务并重置控制器。
	svc = connector.New(connector.Catalog{Categories: []connector.Category{{ID: "dev", Name: "开发"}}}, home)
	t.Cleanup(svc.Close)
	s.connectors = svc
	if got := svc.CustomAuthStatus(connector.CustomKey("old-mcp")); got != "connected" {
		t.Fatalf("seeded auth status = %q", got)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/servers/update",
		strings.NewReader(`{"originalName":"old-mcp","server":{"name":"new-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":true}}`))
	// update 要求服务器已存在。
	addCustomServer(t, s, `{"name":"old-mcp","type":"streamable","url":"`+ts.URL+`/mcp"}`)
	s.mcpServers(rec, req, "update")
	if rec.Code != http.StatusOK {
		t.Fatalf("update: %s", rec.Body.String())
	}
	if got := svc.CustomAuthStatus(connector.CustomKey("new-mcp")); got != "connected" {
		t.Fatalf("token entry not moved on rename: %q", got)
	}
	if got := svc.CustomAuthStatus(connector.CustomKey("old-mcp")); got != "none" {
		t.Fatalf("old token entry left behind: %q", got)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/mcp/servers/remove", strings.NewReader(`{"name":"new-mcp"}`))
	s.mcpServers(rec, req, "remove")
	if rec.Code != http.StatusOK {
		t.Fatalf("remove: %s", rec.Body.String())
	}
	if got := svc.CustomAuthStatus(connector.CustomKey("new-mcp")); got != "none" {
		t.Fatalf("token entry not cleared on remove: %q", got)
	}
}

func TestCustomRedactorHidesHeaderValues(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	server := McpServer{Name: "x", Type: "streamable", URL: "http://h/mcp",
		Headers: map[string]string{"Authorization": "Bearer secret-abc"},
		Env:     map[string]string{"API_KEY": "env-secret"}}
	text := s.customRedactor(server)("GET http://h/mcp failed: Bearer secret-abc env-secret")
	if strings.Contains(text, "secret-abc") || strings.Contains(text, "env-secret") {
		t.Fatalf("secrets leaked: %s", text)
	}
	if !strings.Contains(text, "***") {
		t.Fatalf("expected redaction: %s", text)
	}
}

func TestConnectorListAndSetEnabledIncludeCustom(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	s, _ := newConnectorTestController(t, ts.URL+"/mcp")
	installConnectorTestTools(t, s)
	addCustomServer(t, s, `{"name":"my-mcp","type":"streamable","url":"`+ts.URL+`/mcp","enabled":true}`)

	out := runConnectorTool(t, connectorTool(t, s, "connector_list"), newConnectorToolCtx("sess"), map[string]any{})
	list, _ := out["connectors"].([]any)
	var custom map[string]any
	for _, raw := range list {
		if m, _ := raw.(map[string]any); m["id"] == "my-mcp" {
			custom = m
		}
	}
	if custom == nil || custom["custom"] != true || custom["status"] != "connected" || custom["enabledForSession"] != true {
		t.Fatalf("custom entry = %v", custom)
	}

	setEnabled := connectorTool(t, s, "connector_set_enabled")
	ctx := newConnectorToolCtx("sess")
	out = runConnectorTool(t, setEnabled, ctx, map[string]any{"connectorId": "my-mcp", "enabled": false, "scope": "session"})
	if out["enabled"] != false || s.connectorSessionOverrides("sess")["my-mcp"] != false {
		t.Fatalf("session scope = %v", out)
	}
	out = runConnectorTool(t, setEnabled, ctx, map[string]any{"connectorId": "my-mcp", "enabled": false, "scope": "global"})
	server, _ := s.mcpFind("my-mcp")
	if out["scope"] != "global" || server.Enabled {
		t.Fatalf("global scope = %v enabled=%v", out, server.Enabled)
	}
}

package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeOAuthStack 模拟一条完整的授权链：MCP 资源端点（401 挑战 +
// Bearer 校验）、PRM/AS 元数据、DCR、授权与令牌端点。
type fakeOAuthStack struct {
	server        *httptest.Server
	mux           *http.ServeMux
	token         atomic.Value // 当前有效的 access token
	revoke        atomic.Bool
	checkExcluded atomic.Bool // 连接器声明了 excludeScopes 时校验授权 URL
}

func newFakeOAuthStack(t *testing.T) *fakeOAuthStack {
	t.Helper()
	stack := &fakeOAuthStack{mux: http.NewServeMux()}
	stack.token.Store("access-token-1")

	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "fake-mcp", Version: "0.0.1"}, nil)
	mcp.AddTool(mcpServer, &mcp.Tool{Name: "ping", Description: "ping"},
		func(ctx context.Context, req *mcp.CallToolRequest, args struct{}) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "pong"}}}, nil, nil
		})
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, nil)

	stack.mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		valid := auth == "Bearer "+stack.token.Load().(string) && !stack.revoke.Load()
		if !valid {
			w.Header().Set("WWW-Authenticate",
				fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, stack.server.URL))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mcpHandler.ServeHTTP(w, r)
	}))
	stack.mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, map[string]any{
			"resource":              stack.server.URL + "/mcp",
			"authorization_servers": []string{stack.server.URL},
			"scopes_supported":      []string{"read", "write", "excluded.scope"},
		})
	})
	stack.mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, map[string]any{
			"issuer":                                stack.server.URL,
			"authorization_endpoint":                stack.server.URL + "/authorize",
			"token_endpoint":                        stack.server.URL + "/token",
			"registration_endpoint":                 stack.server.URL + "/register",
			"scopes_supported":                      []string{"read", "write", "excluded.scope", "offline_access"},
			"token_endpoint_auth_methods_supported": []string{"none", "client_secret_post", "client_secret_basic"},
			"code_challenge_methods_supported":      []string{"S256"},
		})
	})
	stack.mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		var meta map[string]any
		if err := json.NewDecoder(r.Body).Decode(&meta); err != nil {
			t.Errorf("bad register body: %v", err)
		}
		meta["client_id"] = "dyn-client-id"
		writeTestJSON(w, meta)
	})
	stack.mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if scope := q.Get("scope"); stack.checkExcluded.Load() && strings.Contains(scope, "excluded.scope") {
			t.Errorf("excluded scope leaked into authorization url: %s", scope)
		}
		redirect, err := url.Parse(q.Get("redirect_uri"))
		if err != nil {
			t.Errorf("bad redirect_uri: %v", err)
			return
		}
		target := *redirect
		v := target.Query()
		v.Set("code", "code-1")
		v.Set("state", q.Get("state"))
		target.RawQuery = v.Encode()
		http.Redirect(w, r, target.String(), http.StatusFound)
	})
	stack.mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("bad token form: %v", err)
		}
		grant := r.Form.Get("grant_type")
		if grant != "authorization_code" && grant != "refresh_token" {
			t.Errorf("unexpected grant_type %q", grant)
		}
		writeTestJSON(w, map[string]any{
			"access_token":  stack.token.Load().(string),
			"refresh_token": "refresh-1",
			"token_type":    "Bearer",
			"expires_in":    3600,
		})
	})
	stack.server = httptest.NewServer(stack.mux)
	t.Cleanup(stack.server.Close)
	return stack
}

func writeTestJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func oauthCatalog(stack *fakeOAuthStack, auth Auth) Catalog {
	return Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "svc", Name: "服务", Category: "dev",
			Transport: Transport{Type: "streamable", URL: stack.server.URL + "/mcp"},
			Auth:      auth,
		}},
	}
}

func waitFlow(t *testing.T, s *Service, flowID, want string) FlowView {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		view, ok := s.FlowStatus(flowID)
		if ok && view.Status == want {
			return view
		}
		time.Sleep(20 * time.Millisecond)
	}
	view, _ := s.FlowStatus(flowID)
	t.Fatalf("flow status = %+v, want %s", view, want)
	return FlowView{}
}

func TestOAuthEndToEndDynamicRegistration(t *testing.T) {
	stack := newFakeOAuthStack(t)
	stack.checkExcluded.Store(true)
	catalog := oauthCatalog(stack, Auth{Type: "oauth", ExcludeScopes: []string{"excluded.scope"}})
	s := New(catalog, t.TempDir())
	defer s.Close()

	flowID, authURL, err := s.StartAuthorization(context.Background(), "svc", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(authURL, stack.server.URL+"/authorize?") {
		t.Fatalf("authorization url = %q", authURL)
	}
	// 模拟用户在浏览器里完成授权：跟随重定向到回环回调。
	resp, err := http.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	waitFlow(t, s, flowID, flowConnected)
	view := s.View("svc")
	if view.Status != StatusConnected || !view.Enabled || view.ConnectedAt == 0 {
		t.Fatalf("entry = %+v", view)
	}

	// 已存令牌应能在运行时直连资源（无需再次授权）。
	tools, err := s.ListTools(context.Background(), "svc")
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0]["name"] != "ping" {
		t.Fatalf("tools = %v", tools)
	}

	// 持久化的 oauth 配置应含 DCR 客户端与令牌。
	stored := s.fieldsFor("svc")
	_ = stored
	s.mu.Lock()
	oauth := s.entries["svc"].OAuth
	s.mu.Unlock()
	if oauth == nil || oauth.ClientID != "dyn-client-id" || oauth.Token == nil || oauth.Token.AccessToken != "access-token-1" {
		t.Fatalf("oauth state = %+v", oauth)
	}
	for _, scope := range oauth.Scopes {
		if scope == "excluded.scope" {
			t.Fatalf("excluded scope persisted: %v", oauth.Scopes)
		}
	}

	// 令牌被吊销后运行时不得发起授权：标记 needs_reauth 并返回哨兵错误。
	stack.revoke.Store(true)
	if _, err := s.ListTools(context.Background(), "svc"); !errors.Is(err, ErrReauthorizationRequired) {
		t.Fatalf("want ErrReauthorizationRequired, got %v", err)
	}
	if view := s.View("svc"); view.Status != StatusNeedsReauth {
		t.Fatalf("status = %q, want needs_reauth", view.Status)
	}
	if _, _, err := s.Runtime("svc"); !errors.Is(err, ErrReauthorizationRequired) {
		t.Fatalf("runtime should refuse needs_reauth connector, got %v", err)
	}
}

func TestOAuthPreregisteredClient(t *testing.T) {
	stack := newFakeOAuthStack(t)
	catalog := oauthCatalog(stack, Auth{
		Type:   "oauth",
		Client: "user",
		Fields: []Field{{Key: "clientId"}, {Key: "clientSecret", Secret: true}},
	})
	s := New(catalog, t.TempDir())
	defer s.Close()

	flowID, authURL, err := s.StartAuthorization(context.Background(), "svc", map[string]string{
		"clientId": "my-client", "clientSecret": "my-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(authURL, "client_id=my-client") {
		t.Fatalf("preregistered client id missing: %q", authURL)
	}
	resp, err := http.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	waitFlow(t, s, flowID, flowConnected)

	s.mu.Lock()
	oauth := s.entries["svc"].OAuth
	s.mu.Unlock()
	if oauth == nil || oauth.ClientID != "my-client" || oauth.ClientSecret != "my-secret" {
		t.Fatalf("oauth state = %+v", oauth)
	}
}

func TestOAuthCancelClosesListener(t *testing.T) {
	stack := newFakeOAuthStack(t)
	catalog := oauthCatalog(stack, Auth{Type: "oauth"})
	s := New(catalog, t.TempDir())
	defer s.Close()

	flowID, authURL, err := s.StartAuthorization(context.Background(), "svc", nil)
	if err != nil {
		t.Fatal(err)
	}
	callback := mustRedirectURI(t, authURL)
	s.CancelFlow(flowID)
	waitFlow(t, s, flowID, flowCancelled)

	// 回调监听器应已关闭。
	conn, err := net.DialTimeout("tcp", callback, time.Second)
	if err == nil {
		conn.Close()
		t.Fatal("callback listener still accepting")
	}
}

// mustRedirectURI 从授权 URL 中取出回环回调端口。
func mustRedirectURI(t *testing.T, authURL string) string {
	t.Helper()
	u, err := url.Parse(authURL)
	if err != nil {
		t.Fatal(err)
	}
	redirect := u.Query().Get("redirect_uri")
	ru, err := url.Parse(redirect)
	if err != nil {
		t.Fatal(err)
	}
	return ru.Host
}

func TestOAuthCallbackSecondHitDoesNotBlock(t *testing.T) {
	f := &flow{result: make(chan *auth.AuthorizationResult, 1)}
	req := httptest.NewRequest(http.MethodGet, "/callback?code=c&state=s", nil)
	rec1 := httptest.NewRecorder()
	(&Service{}).oauthCallback(f, rec1, req)
	rec2 := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		(&Service{}).oauthCallback(f, rec2, req)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("second callback blocked")
	}
	if !strings.Contains(rec2.Body.String(), "已处理") {
		t.Fatalf("second response = %q", rec2.Body.String())
	}
	if got := <-f.result; got == nil || got.Code != "c" {
		t.Fatalf("result = %+v", got)
	}
}

func TestConnectErrorDoesNotLeakSecret(t *testing.T) {
	// 指向已关闭的服务：探测错误会带回完整 URL（含查询里的 key）。
	dead := httptest.NewServer(http.NotFoundHandler())
	key := "AMAPKEY-12345"
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "amap", Category: "dev",
			Transport: Transport{Type: "streamable", URL: dead.URL + "/mcp?key={{key}}"},
			Auth:      Auth{Type: "token", Fields: []Field{{Key: "key", Secret: true}}},
		}},
	}
	dead.Close()
	s := New(catalog, t.TempDir())
	defer s.Close()
	if _, err := s.ConnectCredentials(context.Background(), "amap", map[string]string{"key": key}); err == nil {
		t.Fatal("want connect error")
	} else if strings.Contains(err.Error(), key) || strings.Contains(err.Error(), url.QueryEscape(key)) {
		t.Fatalf("secret leaked: %s", err)
	}
}

func TestOAuthFlowErrorDoesNotLeakSecret(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	key := "AMAPKEY-12345"
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "svc", Category: "dev",
			Transport: Transport{Type: "streamable", URL: dead.URL + "/mcp?key={{key}}"},
			Auth: Auth{
				Type: "oauth", Client: "user",
				Fields: []Field{{Key: "key", Secret: true}, {Key: "clientId"}, {Key: "clientSecret", Secret: true}},
			},
		}},
	}
	dead.Close()
	s := New(catalog, t.TempDir())
	defer s.Close()
	flowID, _, err := s.StartAuthorization(context.Background(), "svc", map[string]string{
		"key": key, "clientId": "c", "clientSecret": "s",
	})
	if err == nil {
		t.Fatal("want flow error")
	}
	for _, text := range []string{err.Error(), func() string { v, _ := s.FlowStatus(flowID); return v.Error }()} {
		if strings.Contains(text, key) || strings.Contains(text, url.QueryEscape(key)) {
			t.Fatalf("secret leaked: %s", text)
		}
	}
}

func TestRuntimeTokenRefreshOutlivesCallerContext(t *testing.T) {
	stack := newFakeOAuthStack(t)
	stack.token.Store("access-token-2")
	catalog := oauthCatalog(stack, Auth{Type: "oauth"})
	dir := t.TempDir()
	s := New(catalog, dir)
	defer s.Close()
	if err := s.mutate(func() error {
		s.entries["svc"] = &entry{
			Enabled: true, Status: StatusConnected,
			OAuth: &OAuthState{
				ClientID: "dyn", TokenURL: stack.server.URL + "/token",
				Token: &StoredToken{
					AccessToken: "expired", RefreshToken: "refresh-1",
					TokenType: "Bearer", Expiry: time.Now().Add(-time.Hour),
				},
			},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, handler, err := s.Runtime("svc")
	if err != nil {
		t.Fatal(err)
	}
	callerCtx, cancel := context.WithCancel(context.Background())
	ts, err := handler.TokenSource(callerCtx)
	if err != nil {
		t.Fatal(err)
	}
	cancel() // 首个请求结束；刷新必须仍然可用。
	token, err := ts.Token()
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "access-token-2" {
		t.Fatalf("access token = %q", token.AccessToken)
	}
	s.mu.Lock()
	stored := s.entries["svc"].OAuth.Token.AccessToken
	s.mu.Unlock()
	if stored != "access-token-2" {
		t.Fatalf("refreshed token not persisted: %q", stored)
	}
}

// 自定义 MCP 服务（custom:<name> 键）复用同一授权流程：
// 仅 DCR，无目录字段与排除 scope。
func TestCustomAuthorizationEndToEnd(t *testing.T) {
	stack := newFakeOAuthStack(t)
	s := New(Catalog{Categories: []Category{{ID: "dev", Name: "开发"}}}, t.TempDir())
	defer s.Close()

	key := CustomKey("notion-mcp")
	spec := Spec{Name: key, Type: "streamable", URL: stack.server.URL + "/mcp"}
	flowID, authURL, err := s.StartCustomAuthorization(context.Background(), key, spec)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	waitFlow(t, s, flowID, flowConnected)

	if got := s.CustomAuthStatus(key); got != "connected" {
		t.Fatalf("authStatus = %q", got)
	}
	if s.CustomRuntime(key) == nil {
		t.Fatal("runtime handler missing after authorization")
	}
	s.mu.Lock()
	oauth := s.entries[key].OAuth
	s.mu.Unlock()
	if oauth == nil || oauth.ClientID != "dyn-client-id" || oauth.Token == nil {
		t.Fatalf("oauth state = %+v", oauth)
	}

	// 退出登录清除条目。
	if err := s.ClearCustom(key); err != nil {
		t.Fatal(err)
	}
	if got := s.CustomAuthStatus(key); got != "none" {
		t.Fatalf("authStatus after signout = %q", got)
	}
	if s.CustomRuntime(key) != nil {
		t.Fatal("runtime handler must be gone after signout")
	}
}

// 改名迁移凭据条目；删除时清除。
func TestCustomRenameAndClear(t *testing.T) {
	s := New(Catalog{Categories: []Category{{ID: "dev", Name: "开发"}}}, t.TempDir())
	defer s.Close()
	old, newer := CustomKey("old"), CustomKey("new")
	if err := s.mutate(func() error {
		s.entries[old] = &entry{Status: StatusConnected, Enabled: true}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameCustom(old, newer); err != nil {
		t.Fatal(err)
	}
	if got := s.CustomAuthStatus(newer); got != "connected" || s.CustomAuthStatus(old) != "none" {
		t.Fatalf("rename failed: old=%q new=%q", s.CustomAuthStatus(old), got)
	}
	if err := s.ClearCustom(newer); err != nil {
		t.Fatal(err)
	}
	if got := s.CustomAuthStatus(newer); got != "none" {
		t.Fatalf("clear failed: %q", got)
	}
}

package connector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
	"golang.org/x/oauth2"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// ErrReauthorizationRequired 表示存储的令牌已被服务端拒绝，
// 需要用户重新完成授权流程；运行时处理器绝不自行打开浏览器。
var ErrReauthorizationRequired = errors.New("connector requires reauthorization")

// flow 是一次进行中的授权流程。
type flow struct {
	id          string
	connectorID string
	status      string // pending | connected | failed | cancelled
	err         string
	url         chan string // 授权 URL 发布后写入
	result      chan *auth.AuthorizationResult
	listener    net.Listener
	cancel      context.CancelFunc
	done        chan struct{}
	expires     time.Time
}

// FlowView 是流程状态快照。
type FlowView struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

const (
	flowPending   = "pending"
	flowConnected = "connected"
	flowFailed    = "failed"
	flowCancelled = "cancelled"

	// 已完成流程保留一段时间供前端轮询结果。
	flowRetention = 2 * time.Minute
)

func newFlowID() string {
	buf := make([]byte, 9)
	_, _ = rand.Read(buf)
	return "cf-" + base64.RawURLEncoding.EncodeToString(buf)
}

// StartAuthorization 打开回环回调监听并发起 OAuth 授权流程，
// 返回 flowID 与授权 URL（前端打开它完成登录）。同一连接器
// 同时只有一个流程；再次发起会取消旧流程。
func (s *Service) StartAuthorization(ctx context.Context, id string, fields map[string]string) (string, string, error) {
	conn, ok := s.catalog.Find(id)
	if !ok {
		return "", "", fmt.Errorf("连接器不存在: %s", id)
	}
	if conn.Auth.Type != "oauth" {
		return "", "", fmt.Errorf("连接器 %s 不支持 OAuth 授权", id)
	}
	if !s.RequirementsMet(conn) {
		return "", "", errRequirement
	}
	clean, err := validateFields(conn, fields)
	if err != nil {
		return "", "", err
	}
	spec, err := s.specFor(conn, clean)
	if err != nil {
		return "", "", err
	}
	if spec.Type != "streamable" && spec.Type != "sse" {
		return "", "", fmt.Errorf("连接器 %s 的传输方式不支持 OAuth", id)
	}
	// client=user 时先保存用户填写的客户端凭据，即使授权中断也保留表单。
	if err := s.mutate(func() error {
		e := s.entries[id]
		if e == nil {
			e = &entry{}
			s.entries[id] = e
		}
		e.Fields = clean
		return nil
	}); err != nil {
		return "", "", err
	}
	return s.startOAuth(ctx, id, spec, func(redirect string, f *flow) (*auth.AuthorizationCodeHandlerConfig, error) {
		return s.handlerConfig(id, &conn, redirect, f)
	})
}

// startOAuth 是与存储键无关的授权流程驱动：按 key 写入 OAuth
// 状态、注册 flow 并等待授权 URL。自定义 MCP 服务用
// "custom:<name>" 作为 key 复用同一机制。
func (s *Service) startOAuth(ctx context.Context, key string, spec Spec, configFor func(redirect string, f *flow) (*auth.AuthorizationCodeHandlerConfig, error)) (string, string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", fmt.Errorf("打开授权回调监听失败: %w", err)
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", listener.Addr().(*net.TCPAddr).Port)

	s.cancelFlowFor(key)
	f := &flow{
		id:          newFlowID(),
		connectorID: key,
		status:      flowPending,
		url:         make(chan string, 1),
		result:      make(chan *auth.AuthorizationResult, 1),
		listener:    listener,
		done:        make(chan struct{}),
	}
	flowCtx, cancel := context.WithTimeout(s.ctx, s.flowTimeout)
	f.cancel = cancel
	s.mu.Lock()
	s.flows[f.id] = f
	s.flowByConnID[key] = f.id
	s.mu.Unlock()

	failEarly := func(err error) (string, string, error) {
		s.finishFlow(f, flowFailed, err)
		cancel()
		_ = listener.Close()
		close(f.done)
		return f.id, "", err
	}
	handlerCfg, err := configFor(redirect, f)
	if err != nil {
		return failEarly(err)
	}
	handler, err := auth.NewAuthorizationCodeHandler(handlerCfg)
	if err != nil {
		return failEarly(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		s.oauthCallback(f, w, r)
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	go s.runOAuthFlow(flowCtx, f, server, spec, handler)

	// 授权 URL 由传输层在收到 401 后异步产出。
	select {
	case url := <-f.url:
		return f.id, url, nil
	case err := <-s.flowFailure(f):
		return f.id, "", err
	case <-time.After(s.urlWaitTime):
		s.cancelFlow(f.id)
		return f.id, "", fmt.Errorf("未能获取授权地址，请重试")
	case <-ctx.Done():
		s.cancelFlow(f.id)
		return f.id, "", ctx.Err()
	}
}

// flowFailure 在流程已失败时返回错误通道语义：立即读或阻塞到 done。
func (s *Service) flowFailure(f *flow) <-chan error {
	ch := make(chan error, 1)
	s.mu.Lock()
	failed := f.status == flowFailed || f.status == flowCancelled
	errText := f.err
	s.mu.Unlock()
	if failed {
		if errText == "" {
			errText = "授权已取消"
		}
		ch <- errors.New(errText)
		return ch
	}
	go func() {
		<-f.done
		s.mu.Lock()
		text := f.err
		s.mu.Unlock()
		if text == "" {
			text = "授权已取消"
		}
		ch <- errors.New(text)
	}()
	return ch
}

// handlerConfig 组装 SDK 授权处理器配置：client=user 用预注册凭据，
// 否则动态客户端注册；两者都启用刷新令牌并过滤排除的 scope。
func (s *Service) handlerConfig(key string, conn *Connector, redirect string, f *flow) (*auth.AuthorizationCodeHandlerConfig, error) {
	cfg := &auth.AuthorizationCodeHandlerConfig{
		RedirectURL:         redirect,
		RequestRefreshToken: true,
		AuthorizationCodeFetcher: func(ctx context.Context, args *auth.AuthorizationArgs) (*auth.AuthorizationResult, error) {
			select {
			case f.url <- args.URL:
			default:
			}
			select {
			case result := <-f.result:
				if result == nil {
					return nil, errors.New("授权失败")
				}
				return result, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		NewTokenSource: func(ctx context.Context, cfg *oauth2.Config, token *oauth2.Token) (oauth2.TokenSource, error) {
			if err := s.saveOAuthState(key, cfg, token); err != nil {
				return nil, err
			}
			return &persistingTokenSource{
				svc:   s,
				id:    key,
				cfg:   cfg,
				inner: cfg.TokenSource(ctx, token),
				last:  token.AccessToken,
			}, nil
		},
	}
	if conn != nil && len(conn.Auth.ExcludeScopes) > 0 {
		excluded := map[string]bool{}
		for _, scope := range conn.Auth.ExcludeScopes {
			excluded[scope] = true
		}
		cfg.ScopeFilter = func(discovered []string) []string {
			out := make([]string, 0, len(discovered))
			for _, scope := range discovered {
				if !excluded[scope] {
					out = append(out, scope)
				}
			}
			return out
		}
	}
	if conn != nil && conn.Auth.Client == "user" {
		fields := s.fieldsFor(conn.ID)
		creds := &oauthex.ClientCredentials{ClientID: fields["clientId"]}
		if secret := fields["clientSecret"]; secret != "" {
			creds.ClientSecretAuth = &oauthex.ClientSecretAuth{ClientSecret: secret}
		}
		cfg.PreregisteredClient = creds
	} else {
		cfg.DynamicClientRegistrationConfig = &auth.DynamicClientRegistrationConfig{
			Metadata: &oauthex.ClientRegistrationMetadata{
				ClientName:              "Loopra",
				RedirectURIs:            []string{redirect},
				GrantTypes:              []string{"authorization_code", "refresh_token"},
				ResponseTypes:           []string{"code"},
				TokenEndpointAuthMethod: "none",
			},
		}
	}
	return cfg, nil
}

// runOAuthFlow 驱动一次 MCP 连接以触发授权并在成功后列出工具、
// 标记连接器 connected；结束时关闭监听器并通知等待方。
func (s *Service) runOAuthFlow(ctx context.Context, f *flow, server *http.Server, spec Spec, handler *auth.AuthorizationCodeHandler) {
	defer close(f.done)
	defer server.Close()

	transport, err := specTransport(spec, handler)
	if err == nil {
		client := mcp.NewClient(&mcp.Implementation{Name: "loopra", Version: "1.0.0"}, nil)
		var session *mcp.ClientSession
		session, err = client.Connect(ctx, transport, nil)
		if err == nil {
			_, err = session.ListTools(ctx, nil)
			_ = session.Close()
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			s.finishFlow(f, flowCancelled, nil)
			return
		}
		// 流程错误会轮询透出，只保留稳定文案；细节进日志且不含凭据。
		logging.Debugf("connector", "oauth flow %s for %s failed: %s", f.id, f.connectorID, s.Redactor(f.connectorID)(err.Error()))
		s.finishFlow(f, flowFailed, errors.New("授权失败，请重试"))
		return
	}
	if err := s.mutate(func() error {
		e := s.entries[f.connectorID]
		if e == nil {
			e = &entry{}
			s.entries[f.connectorID] = e
		}
		e.Enabled = true
		e.ConnectedAt = time.Now().UnixMilli()
		e.Status = StatusConnected
		return nil
	}); err != nil {
		s.finishFlow(f, flowFailed, err)
		return
	}
	s.finishFlow(f, flowConnected, nil)
}

// oauthCallback 接收授权服务器回跳并交付 code/state/iss。
func (s *Service) oauthCallback(f *flow, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// 回调可能被浏览器重试；非阻塞投递，重复访问提示已处理。
	deliver := func(result *auth.AuthorizationResult) bool {
		select {
		case f.result <- result:
			return true
		default:
			return false
		}
	}
	q := r.URL.Query()
	if q.Get("error") != "" {
		message := q.Get("error_description")
		if message == "" {
			message = q.Get("error")
		}
		if !deliver(nil) {
			fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Loopra</title><p>该授权请求已处理。</p>`)
			return
		}
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Loopra</title><p>授权失败：%s</p>`, html.EscapeString(message))
		return
	}
	code := q.Get("code")
	if code == "" {
		if !deliver(nil) {
			fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Loopra</title><p>该授权请求已处理。</p>`)
			return
		}
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Loopra</title><p>授权失败：缺少授权码。</p>`)
		return
	}
	if !deliver(&auth.AuthorizationResult{Code: code, State: q.Get("state"), Iss: q.Get("iss")}) {
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Loopra</title><p>该授权请求已处理。</p>`)
		return
	}
	fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Loopra</title><p>授权完成，可以返回 Loopra 了。</p>`)
}

// finishFlow 写入终态；完成后仅短暂保留供轮询。
func (s *Service) finishFlow(f *flow, status string, err error) {
	s.mu.Lock()
	if f.status == flowPending {
		f.status = status
		if err != nil {
			f.err = err.Error()
		}
	}
	f.expires = time.Now().Add(flowRetention)
	s.mu.Unlock()
	go func() {
		<-time.After(flowRetention + time.Second)
		s.mu.Lock()
		if time.Now().After(f.expires) {
			delete(s.flows, f.id)
			if s.flowByConnID[f.connectorID] == f.id {
				delete(s.flowByConnID, f.connectorID)
			}
		}
		s.mu.Unlock()
	}()
}

// FlowStatus 查询流程状态。
func (s *Service) FlowStatus(flowID string) (FlowView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.flows[flowID]
	if f == nil {
		return FlowView{}, false
	}
	return FlowView{Status: f.status, Error: f.err}, true
}

// CancelFlow 取消流程：终止流程上下文并关闭监听。
func (s *Service) CancelFlow(flowID string) {
	s.mu.Lock()
	f := s.flows[flowID]
	s.mu.Unlock()
	if f != nil {
		s.cancelFlowObj(f)
	}
}

func (s *Service) cancelFlow(flowID string) { s.CancelFlow(flowID) }

func (s *Service) cancelFlowFor(connectorID string) {
	s.mu.Lock()
	id := s.flowByConnID[connectorID]
	f := s.flows[id]
	pending := f != nil && f.status == flowPending
	s.mu.Unlock()
	if pending {
		s.cancelFlowObj(f)
	}
}

func (s *Service) cancelFlowObj(f *flow) {
	s.finishFlow(f, flowCancelled, nil)
	f.cancel()
	_ = f.listener.Close()
}

// saveOAuthState 持久化 SDK 交付的客户端配置与首个令牌。
func (s *Service) saveOAuthState(id string, cfg *oauth2.Config, token *oauth2.Token) error {
	return s.mutate(func() error {
		e := s.entries[id]
		if e == nil {
			e = &entry{Status: StatusConnected, Enabled: true}
			s.entries[id] = e
		}
		e.OAuth = &OAuthState{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			AuthURL:      cfg.Endpoint.AuthURL,
			TokenURL:     cfg.Endpoint.TokenURL,
			AuthStyle:    int(cfg.Endpoint.AuthStyle),
			Scopes:       cfg.Scopes,
			Token:        storedTokenFrom(token),
		}
		return nil
	})
}

// saveToken 在刷新后更新已存令牌；失败仅记日志（不含令牌值），
// 下一次刷新仍会重试。
func (s *Service) saveToken(id string, cfg *oauth2.Config, token *oauth2.Token) {
	if err := s.saveOAuthState(id, cfg, token); err != nil {
		logging.Warnf("connector", "persist refreshed token for %s: %v", id, err)
	}
}

// persistingTokenSource 包装刷新令牌源，令牌变化时写回存储。
type persistingTokenSource struct {
	svc   *Service
	id    string
	cfg   *oauth2.Config
	inner oauth2.TokenSource
	mu    sync.Mutex
	last  string
}

func (p *persistingTokenSource) Token() (*oauth2.Token, error) {
	token, err := p.inner.Token()
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	changed := token.AccessToken != p.last
	p.last = token.AccessToken
	p.mu.Unlock()
	if changed {
		p.svc.saveToken(p.id, p.cfg, token)
	}
	return token, nil
}

// runtimeOAuth 是运行时 OAuth 处理器：仅提供持久化令牌源，
// 收到 401/403 时标记 needs_reauth 并返回哨兵错误，绝不打开浏览器。
type runtimeOAuth struct {
	svc *Service
	id  string

	mu sync.Mutex
	ts oauth2.TokenSource
}

func (h *runtimeOAuth) TokenSource(ctx context.Context) (oauth2.TokenSource, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ts != nil {
		return h.ts, nil
	}
	s := h.svc
	s.mu.Lock()
	if err := s.loadLocked(); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	e := s.entries[h.id]
	var state *OAuthState
	if e != nil {
		state = e.OAuth
	}
	s.mu.Unlock()
	if state == nil || state.Token == nil {
		return nil, nil
	}
	cfg := state.oauth2Config()
	// oauth2 会把构造时的 ctx 留给后续每次刷新；用服务生命周期
	// 的 ctx，否则首个请求结束后刷新全部失败。
	refreshCtx := context.WithValue(h.svc.ctx, oauth2.HTTPClient, http.DefaultClient)
	h.ts = &persistingTokenSource{
		svc:   s,
		id:    h.id,
		cfg:   cfg,
		inner: cfg.TokenSource(refreshCtx, state.Token.oauth2Token()),
		last:  state.Token.AccessToken,
	}
	return h.ts, nil
}

// Authorize 不发起授权：运行时无权打扰用户，直接标记重授权。
func (h *runtimeOAuth) Authorize(ctx context.Context, req *http.Request, resp *http.Response) error {
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	h.svc.markNeedsReauth(h.id)
	return ErrReauthorizationRequired
}

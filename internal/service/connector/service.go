package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	mcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ezdemo/looprax/internal/infrastructure/hideconsole"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// Service 管理连接器目录、凭据存储与 OAuth 流程。
type Service struct {
	catalog Catalog
	path    string

	mu        sync.Mutex
	loaded    bool
	entries   map[string]*entry
	fileExtra map[string]json.RawMessage

	flows        map[string]*flow
	flowByConnID map[string]string
	ctx          context.Context // 进程生命周期，取消时全部流程终止
	cancel       context.CancelFunc
	lookPath     func(string) (string, error)
	flowTimeout  time.Duration
	urlWaitTime  time.Duration
}

// Option 覆盖 Service 默认行为（主要供测试注入）。
type Option func(*Service)

// WithLookPath 覆盖可执行文件解析（requirements 检查用）。
func WithLookPath(fn func(string) (string, error)) Option {
	return func(s *Service) { s.lookPath = fn }
}

// WithFlowTimeout 覆盖 OAuth 流程的整体超时。
func WithFlowTimeout(d time.Duration) Option {
	return func(s *Service) { s.flowTimeout = d }
}

// New 以给定目录与 <home>/connectors.json 存储构建服务。
func New(catalog Catalog, home string, opts ...Option) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		catalog:      catalog,
		path:         filepath.Join(home, "connectors.json"),
		flows:        map[string]*flow{},
		flowByConnID: map[string]string{},
		ctx:          ctx,
		cancel:       cancel,
		lookPath:     exec.LookPath,
		flowTimeout:  5 * time.Minute,
		urlWaitTime:  30 * time.Second,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Close 取消所有进行中的授权流程；可重复调用。
func (s *Service) Close() {
	s.cancel()
	s.mu.Lock()
	flows := make([]*flow, 0, len(s.flows))
	for _, f := range s.flows {
		flows = append(flows, f)
	}
	s.mu.Unlock()
	for _, f := range flows {
		<-f.done
	}
}

// Catalog 返回内置目录。
func (s *Service) Catalog() Catalog { return s.catalog }

// OAuthRuntime 是接入 MCP 传输的 OAuth 处理器别名。
type OAuthRuntime = auth.OAuthHandler

// EntryView 是不含凭据与令牌的连接器状态快照，可安全进入 API 响应。
type EntryView struct {
	Connected        bool     `json:"connected"`
	Status           string   `json:"status"` // connected | needs_reauth | ""
	Enabled          bool     `json:"enabled"`
	ConnectedAt      int64    `json:"connectedAt,omitempty"`
	ConfiguredFields []string `json:"configuredFields,omitempty"`
}

// View 返回连接器的存储状态；未连接时返回零值视图。
func (s *Service) View(id string) EntryView {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return EntryView{}
	}
	e := s.entries[id]
	if e == nil {
		return EntryView{}
	}
	view := EntryView{
		Status:      e.Status,
		Enabled:     e.Enabled,
		ConnectedAt: e.ConnectedAt,
		Connected:   e.Status == StatusConnected || e.Status == StatusNeedsReauth,
	}
	for key := range e.Fields {
		view.ConfiguredFields = append(view.ConfiguredFields, key)
	}
	return view
}

// RequirementsMet 检查 requires 声明：目前仅 "node"，要求 npx 可解析。
func (s *Service) RequirementsMet(conn Connector) bool {
	for _, req := range conn.Requires {
		switch req {
		case "node":
			if _, err := s.lookPath("npx"); err != nil {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// errRequirement 是连接因环境不满足被拒的错误。
var errRequirement = errors.New("运行环境不满足连接器要求（需要 Node.js，未找到 npx）")

// errConnectFailed 是凭据探测失败时对外的稳定文案；细节只进日志。
var errConnectFailed = errors.New("连接失败，请检查凭据")

// Redactor 返回一个把该连接器已存凭据值（含 URL 转义形式与
// OAuth 令牌）替换为 *** 的函数，用于进入响应或模型上下文的
// 错误文本。
func (s *Service) Redactor(id string) func(string) string {
	s.mu.Lock()
	_ = s.loadLocked()
	var secrets []string
	if e := s.entries[id]; e != nil {
		for _, value := range e.Fields {
			if value != "" {
				secrets = append(secrets, value)
			}
		}
		if e.OAuth != nil {
			for _, value := range []string{e.OAuth.ClientSecret} {
				if value != "" {
					secrets = append(secrets, value)
				}
			}
			if t := e.OAuth.Token; t != nil {
				for _, value := range []string{t.AccessToken, t.RefreshToken} {
					if value != "" {
						secrets = append(secrets, value)
					}
				}
			}
		}
	}
	s.mu.Unlock()
	return func(text string) string {
		for _, secret := range secrets {
			text = strings.ReplaceAll(text, secret, "***")
			text = strings.ReplaceAll(text, url.QueryEscape(secret), "***")
		}
		return text
	}
}

// specFor 返回连接器的实例化传输描述。仅供内部及传输构建使用。
func (s *Service) specFor(conn Connector, fields map[string]string) (Spec, error) {
	return Render(conn, fields)
}

// fieldsFor 读取已存字段（内部使用，值不出包）。
func (s *Service) fieldsFor(id string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return nil
	}
	e := s.entries[id]
	if e == nil {
		return nil
	}
	fields := map[string]string{}
	for k, v := range e.Fields {
		fields[k] = v
	}
	return fields
}

// ConnectCredentials 验证字段、用实例化传输探测工具列表，成功后
// 持久化字段并标记 connected。适用于 token / credentials 类型。
func (s *Service) ConnectCredentials(ctx context.Context, id string, fields map[string]string) (int, error) {
	conn, ok := s.catalog.Find(id)
	if !ok {
		return 0, fmt.Errorf("连接器不存在: %s", id)
	}
	if conn.Auth.Type == "oauth" {
		return 0, fmt.Errorf("连接器 %s 需要通过 OAuth 授权", id)
	}
	if !s.RequirementsMet(conn) {
		return 0, errRequirement
	}
	clean, err := validateFields(conn, fields)
	if err != nil {
		return 0, err
	}
	spec, err := s.specFor(conn, clean)
	if err != nil {
		return 0, err
	}
	tools, err := s.listTools(ctx, spec, nil)
	if err != nil {
		logging.Debugf("connector", "connect probe %s failed: %s", id, s.Redactor(id)(err.Error()))
		return 0, errConnectFailed
	}
	err = s.mutate(func() error {
		s.entries[id] = s.connectedEntry(conn, clean, nil)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return len(tools), nil
}

// connectedEntry 构造一条 connected 记录。
func (s *Service) connectedEntry(conn Connector, fields map[string]string, oauth *OAuthState) *entry {
	e := &entry{
		Enabled:     true,
		ConnectedAt: time.Now().UnixMilli(),
		Status:      StatusConnected,
		Fields:      fields,
		OAuth:       oauth,
	}
	if old := s.entries[conn.ID]; old != nil {
		e.extra = old.extra
	}
	return e
}

// Toggle 设置连接器的全局启用位。
func (s *Service) Toggle(id string, enabled bool) error {
	if _, ok := s.catalog.Find(id); !ok {
		return fmt.Errorf("连接器不存在: %s", id)
	}
	return s.mutate(func() error {
		e := s.entries[id]
		if e == nil {
			return fmt.Errorf("连接器 %s 尚未连接", id)
		}
		e.Enabled = enabled
		return nil
	})
}

// Disconnect 删除字段与令牌；目录条目保留。
func (s *Service) Disconnect(id string) error {
	if _, ok := s.catalog.Find(id); !ok {
		return fmt.Errorf("连接器不存在: %s", id)
	}
	s.cancelFlowFor(id)
	return s.mutate(func() error {
		delete(s.entries, id)
		return nil
	})
}

// markNeedsReauth 把连接器标记为需要重新授权。
func (s *Service) markNeedsReauth(id string) {
	_ = s.mutate(func() error {
		if e := s.entries[id]; e != nil && e.Status == StatusConnected {
			e.Status = StatusNeedsReauth
		}
		return nil
	})
}

// ListTools 用已存凭据连接连接器并列出工具，供 /tools 端点使用。
func (s *Service) ListTools(ctx context.Context, id string) ([]map[string]any, error) {
	conn, spec, handler, err := s.runtime(id)
	if err != nil {
		return nil, err
	}
	_ = conn
	tools, err := s.listTools(ctx, spec, handler)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		out = append(out, map[string]any{"name": t.Name, "description": t.Description})
	}
	return out, nil
}

// Runtime 解析已连接连接器为传输描述与 OAuth 处理器；
// 返回的 Spec 含敏感值，只能进入传输层。未连接、需要重新授权
// 或环境不满足时返回错误。
func (s *Service) Runtime(id string) (Spec, OAuthRuntime, error) {
	_, spec, handler, err := s.runtime(id)
	return spec, handler, err
}

func (s *Service) runtime(id string) (Connector, Spec, OAuthRuntime, error) {
	conn, ok := s.catalog.Find(id)
	if !ok {
		return Connector{}, Spec{}, nil, fmt.Errorf("连接器不存在: %s", id)
	}
	if !s.RequirementsMet(conn) {
		return conn, Spec{}, nil, errRequirement
	}
	view := s.View(id)
	if view.Status == StatusNeedsReauth {
		return conn, Spec{}, nil, ErrReauthorizationRequired
	}
	if !view.Connected {
		return conn, Spec{}, nil, fmt.Errorf("连接器 %s 尚未连接", id)
	}
	spec, err := s.specFor(conn, s.fieldsFor(id))
	if err != nil {
		return conn, Spec{}, nil, err
	}
	var handler OAuthRuntime
	if conn.Auth.Type == "oauth" {
		handler = &runtimeOAuth{svc: s, id: id}
	}
	return conn, spec, handler, nil
}

// listTools 建立一次短连接并枚举工具。
func (s *Service) listTools(ctx context.Context, spec Spec, handler OAuthRuntime) ([]*mcp.Tool, error) {
	transport, err := specTransport(spec, handler)
	if err != nil {
		return nil, err
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "loopra", Version: "1.0.0"}, nil)
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, err
	}
	defer session.Close()
	result, err := session.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	return result.Tools, nil
}

// headerTransport 把静态头注入每次请求（令牌等敏感值）。
type headerTransport struct {
	base    http.RoundTripper
	headers map[string]string
}

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	for k, v := range t.headers {
		clone.Header.Set(k, v)
	}
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(clone)
}

func envPairs(env map[string]string) []string {
	pairs := make([]string, 0, len(env))
	for k, v := range env {
		pairs = append(pairs, k+"="+v)
	}
	return pairs
}

// specTransport 由实例化描述构建 MCP 传输。
func specTransport(spec Spec, handler OAuthRuntime) (mcp.Transport, error) {
	switch spec.Type {
	case "stdio":
		cmd := exec.Command(spec.Command, spec.Args...)
		hideconsole.Apply(cmd)
		if len(spec.Env) > 0 {
			cmd.Env = append(os.Environ(), envPairs(spec.Env)...)
		}
		return &mcp.CommandTransport{Command: cmd}, nil
	case "sse":
		return &mcp.SSEClientTransport{Endpoint: spec.URL, HTTPClient: &http.Client{
			Transport: headerTransport{headers: spec.Headers},
		}}, nil
	case "streamable":
		return &mcp.StreamableClientTransport{
			Endpoint:     spec.URL,
			HTTPClient:   &http.Client{Transport: headerTransport{headers: spec.Headers}},
			OAuthHandler: handler,
			MaxRetries:   -1,
		}, nil
	default:
		return nil, fmt.Errorf("未知的传输类型: %s", spec.Type)
	}
}

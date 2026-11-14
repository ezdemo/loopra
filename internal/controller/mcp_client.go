package controller

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"

	"github.com/ezdemo/looprax/internal/service/connector"
	"github.com/ezdemo/looprax/internal/service/toolsearch"
)

type headerTransport struct {
	Base    http.RoundTripper
	Headers map[string]string
}

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	for key, value := range t.Headers {
		clone.Header.Set(key, value)
	}
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(clone)
}

func mcpClientConfig(server McpServer) mcptoolset.Config {
	client := &http.Client{Transport: headerTransport{Headers: server.Headers}}
	switch server.Type {
	case "stdio":
		cmd := exec.Command(server.Command, server.Args...)
		hideProcess(cmd)
		if len(server.Env) > 0 {
			cmd.Env = append(os.Environ(), envPairs(server.Env)...)
		}
		return mcptoolset.Config{Transport: &mcp.CommandTransport{Command: cmd}}
	case "sse":
		return mcptoolset.Config{Transport: &mcp.SSEClientTransport{Endpoint: server.URL, HTTPClient: client}}
	default:
		return mcptoolset.Config{Transport: &mcp.StreamableClientTransport{Endpoint: server.URL, HTTPClient: client, MaxRetries: -1, OAuthHandler: server.OAuth}}
	}
}

func (s *Controller) configuredMcpServers() []McpServer {
	servers := map[string]McpServer{}
	for _, server := range s.mcpView() {
		servers[server.Name] = server
	}
	for _, server := range projectMcpServers(filepath.Join(s.workspaceRoot(), ".loopra", "mcp-servers.json")) {
		servers[server.Name] = server
	}
	out := []McpServer{}
	preferences := s.engineMcpPreferences()
	for _, server := range servers {
		if enabled, ok := preferences.Agents["native"][server.Name]; ok {
			server.Enabled = enabled
		}
		out = append(out, server)
	}
	return out
}

// connectorMcpServers 把已连接且本会话启用的连接器展开为同名
// MCP 服务。连接器与自定义 MCP 服务同名时以连接器为准；
// needs_reauth 或环境不满足的连接器跳过。
func (s *Controller) connectorMcpServers(session string) map[string]McpServer {
	out := map[string]McpServer{}
	if s.connectors == nil {
		return out
	}
	overrides := s.connectorSessionOverrides(session)
	for _, conn := range s.connectors.Catalog().Connectors {
		view := s.connectors.View(conn.ID)
		if view.Status != connector.StatusConnected {
			continue
		}
		enabled := view.Enabled
		if override, ok := overrides[conn.ID]; ok {
			enabled = override
		}
		if !enabled {
			continue
		}
		spec, handler, err := s.connectors.Runtime(conn.ID)
		if err != nil {
			continue
		}
		server := McpServer{
			Name: conn.ID, Type: spec.Type, Enabled: true,
			Command: spec.Command, Args: spec.Args, Env: spec.Env,
			URL: spec.URL, Headers: spec.Headers, OAuth: handler,
		}
		out[server.Name] = server
	}
	return out
}

// mergeRequestConnectors 把聊天请求携带的连接器开关并入会话
// .meta（忽略目录外 id），与 PUT /connectors/session 同一存储。
func (s *Controller) mergeRequestConnectors(session string, connectors map[string]bool) {
	if s.connectors == nil || session == "" {
		return
	}
	s.sessionMetaUpdate(session, func(meta map[string]any) {
		overrides, _ := meta["connectors"].(map[string]any)
		if overrides == nil {
			overrides = map[string]any{}
		}
		for id, enabled := range connectors {
			if _, ok := s.connectors.Catalog().Find(id); ok {
				overrides[id] = enabled
				continue
			}
			// 聊天请求同样可以带自定义 MCP 服务名。
			if _, ok := s.mcpFind(id); ok {
				overrides[id] = enabled
			}
		}
		meta["connectors"] = overrides
	})
}

// connectorSessionOverrides 读取会话 .meta 里的连接器开关
// （meta["connectors"]，id → bool）。
func (s *Controller) connectorSessionOverrides(session string) map[string]bool {
	out := map[string]bool{}
	if session == "" {
		return out
	}
	values, _ := s.sessionMetaRead(session)["connectors"].(map[string]any)
	for id, value := range values {
		if enabled, ok := value.(bool); ok {
			out[id] = enabled
		}
	}
	return out
}

// connectorSource 把一个连接器展开为 toolsearch 源；turnMcpSets 与
// connector_request 热加源共用，保持审批与 Redact 行为一致。
func (s *Controller) connectorSource(session string, server McpServer) (toolsearch.Source, error) {
	cfg := mcpClientConfig(server)
	cfg.RequireConfirmationProvider = func(name string, args any) bool {
		input, _ := args.(map[string]any)
		return s.approvalPolicy != nil && s.approvalPolicy.Require(session, toolsearch.QualifiedName(server.Name, name), input)
	}
	set, err := mcptoolset.New(cfg)
	if err != nil {
		return toolsearch.Source{}, err
	}
	return toolsearch.Source{
		Name: server.Name, Toolset: set, Timeout: 15 * time.Second,
		Redact: s.connectors.Redactor(server.Name),
	}, nil
}

// turnMcpSets 组装本轮的延迟工具集。连接器服务存在时始终创建空集，
// 让 connector_request 能在本轮内热加刚连上的源。
func (s *Controller) turnMcpSets(session string) (*toolsearch.Set, []io.Closer) {
	sources := []toolsearch.Source{}
	connectors := s.connectorMcpServers(session)
	overrides := s.connectorSessionOverrides(session)
	for _, server := range s.configuredMcpServers() {
		// 连接器优先于同名自定义 MCP 服务。
		if _, taken := connectors[server.Name]; taken {
			continue
		}
		// 会话级开关对自定义服务同样生效。
		if override, ok := overrides[server.Name]; ok {
			server.Enabled = override
		}
		if !server.Enabled {
			continue
		}
		if s.connectors != nil && (server.Type == "streamable" || server.Type == "sse") {
			// 已授权的自定义远程服务使用与内置连接器一致的
			// 运行时处理器：401 标记 needs_reauth，不打开浏览器。
			if handler := s.connectors.CustomRuntime(connector.CustomKey(server.Name)); handler != nil {
				server.OAuth = handler
			}
		}
		cfg := mcpClientConfig(server)
		filter := func(ctx agentctx.ReadonlyContext, t tool.Tool) bool {
			return !containsString(server.DisallowedTools, t.Name())
		}
		cfg.RequireConfirmationProvider = func(name string, args any) bool {
			input, _ := args.(map[string]any)
			return s.approvalPolicy != nil && s.approvalPolicy.Require(session, toolsearch.QualifiedName(server.Name, name), input)
		}
		set, err := mcptoolset.New(cfg)
		if err != nil {
			continue
		}
		timeout := 15 * time.Second
		if configured, err := parseMcpTimeout(server.Timeout); err == nil {
			timeout = configured
		}
		sources = append(sources, toolsearch.Source{
			Name: server.Name, Toolset: set, Timeout: timeout, Filter: filter,
			Redact: s.customRedactor(server),
		})
	}
	for _, server := range connectors {
		source, err := s.connectorSource(session, server)
		if err != nil {
			continue
		}
		sources = append(sources, source)
	}
	if len(sources) == 0 && s.connectors == nil {
		return nil, nil
	}
	deferred, err := toolsearch.New(sources)
	if err != nil {
		for _, source := range sources {
			if closer, ok := source.Toolset.(io.Closer); ok {
				_ = closer.Close()
			}
		}
		return nil, nil
	}
	return deferred, []io.Closer{deferred}
}

func (s *Controller) closeTurnTools() {
	for _, closer := range s.turnClosers {
		_ = closer.Close()
	}
}

// customRedactor 遮蔽自定义服务错误里的敏感值：请求头、环境变量
// 以及 connectors.json 中保存的 OAuth 凭据。
func (s *Controller) customRedactor(server McpServer) func(string) string {
	var secrets []string
	for _, value := range server.Headers {
		if value != "" {
			secrets = append(secrets, value)
		}
	}
	for _, value := range server.Env {
		if value != "" {
			secrets = append(secrets, value)
		}
	}
	inner := func(text string) string {
		for _, secret := range secrets {
			text = strings.ReplaceAll(text, secret, "***")
			text = strings.ReplaceAll(text, url.QueryEscape(secret), "***")
		}
		return text
	}
	if s.connectors == nil {
		return inner
	}
	oauth := s.connectors.Redactor(connector.CustomKey(server.Name))
	return func(text string) string { return inner(oauth(text)) }
}

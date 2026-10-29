package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/mcptoolset"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/repository"
)

// McpServer 对应 McpServerDTO（API_CONTRACT.md §3.6）：一个已配置的
// MCP 服务及其传输细节。
type McpServer struct {
	Name            string            `json:"name"`
	Type            string            `json:"type"` // stdio | sse | streamable
	Enabled         bool              `json:"enabled"`
	Command         string            `json:"command,omitempty"`
	Args            []string          `json:"args,omitempty"`
	Env             map[string]string `json:"env,omitempty"`
	URL             string            `json:"url,omitempty"`
	Headers         map[string]string `json:"headers,omitempty"`
	Timeout         string            `json:"timeout,omitempty"` // "30s" | "500ms" | "2m"
	DisallowedTools []string          `json:"disallowedTools,omitempty"`
}

func (m *McpServer) UnmarshalJSON(data []byte) error {
	type plain McpServer
	value := plain{Enabled: true}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*m = McpServer(value)
	return nil
}

var mcpNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// validate 校验 DTO 规则：名称模式、传输配置完整性
// （stdio 需要 command，sse/streamable 需要 http(s) url）
// 以及超时时长格式。
func (m McpServer) validate() error {
	if !mcpNamePattern.MatchString(m.Name) {
		return fmt.Errorf("服务器名称只能包含字母、数字、下划线和连字符: %s", m.Name)
	}
	switch m.Type {
	case "stdio":
		if strings.TrimSpace(m.Command) == "" {
			return fmt.Errorf("stdio 类型服务器 %s 必须指定 command", m.Name)
		}
	case "sse", "streamable":
		if strings.TrimSpace(m.URL) == "" {
			return fmt.Errorf("%s 类型服务器 %s 必须指定 url", m.Type, m.Name)
		}
		u, err := url.Parse(m.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return fmt.Errorf("%s 类型服务器 %s 的 url 必须是 http(s) 地址", m.Type, m.Name)
		}
	default:
		return fmt.Errorf("未知的服务器类型: %s", m.Type)
	}
	if m.Timeout != "" {
		if _, err := parseMcpTimeout(m.Timeout); err != nil {
			return err
		}
	}
	return nil
}

// parseMcpTimeout 接受 Go 时长语法（"30s"、"500ms"、"2m"）。
func parseMcpTimeout(s string) (time.Duration, error) {
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("超时格式不正确（如 30s、500ms、2m）: %s", s)
	}
	return d, nil
}

// mcpConfigFile 对应双格式的 ~/.loopra/mcp-servers.json：原生
// "servers" 数组加上由外部工具管理的标准 "mcpServers" 对象映射；
// 两种视图保持互通。
type mcpConfigFile struct {
	Servers    []McpServer               `json:"servers"`
	McpServers map[string]map[string]any `json:"mcpServers"`
}

// mcpStore 缓存两部分；原生条目经由数组往返，
// 外部条目则原样保留其原始载荷（OAuth 等）。
type mcpStore struct {
	mu       sync.Mutex
	native   []McpServer
	external map[string]map[string]any
	ready    bool
}

func (s *Controller) mcpPath() string {
	return filepath.Join(s.home, "mcp-servers.json")
}

// mcpLoad 从磁盘填充缓存（每进程首次访问时）。
func (s *Controller) mcpLoad() {
	s.mcp.mu.Lock()
	defer s.mcp.mu.Unlock()
	if s.mcp.ready {
		return
	}
	s.mcp.native = []McpServer{}
	s.mcp.external = map[string]map[string]any{}
	var file mcpConfigFile
	if data, err := os.ReadFile(s.mcpPath()); err == nil {
		_ = json.Unmarshal(data, &file)
	}
	for _, srv := range file.Servers {
		if srv.Type == "" {
			srv.Type = "stdio"
		}
		s.mcp.native = append(s.mcp.native, srv)
	}
	for name, raw := range file.McpServers {
		if raw == nil {
			continue
		}
		raw["name"] = name
		s.mcp.external[name] = raw
	}
	s.mcp.ready = true
}

// mcpPersist 原子写入两部分（streamable 在外部映射中
// 以 "http" 往返，与 Java 行为一致）。
func (s *Controller) mcpPersist() {
	s.mcp.mu.Lock()
	defer s.mcp.mu.Unlock()
	file := mcpConfigFile{Servers: s.mcp.native, McpServers: s.mcp.external}
	for _, raw := range file.McpServers {
		if t, _ := raw["type"].(string); t == "streamable" {
			raw["type"] = "http"
		}
	}
	data, _ := json.MarshalIndent(file, "", "  ")
	tmp := s.mcpPath() + ".tmp"
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, s.mcpPath())
	}
}

// externalToServer 按 Java 的回退链转换一条 mcpServers 条目：
// type -> transport -> 有 command 无 url 为 stdio，否则为 streamable。
func externalToServer(raw map[string]any) McpServer {
	name, _ := raw["name"].(string)
	typ, _ := raw["type"].(string)
	if typ == "" {
		typ, _ = raw["transport"].(string)
	}
	command, _ := raw["command"].(string)
	url, _ := raw["url"].(string)
	if typ == "" {
		if command != "" && url == "" {
			typ = "stdio"
		} else {
			typ = "streamable"
		}
	}
	switch typ {
	case "http", "streamable-http":
		typ = "streamable"
	}
	server := McpServer{Name: name, Type: typ, Command: command, URL: url, Enabled: true}
	if enabled, ok := raw["enabled"].(bool); ok {
		server.Enabled = enabled
	}
	if args, ok := raw["args"].([]any); ok {
		for _, a := range args {
			if str, ok := a.(string); ok {
				server.Args = append(server.Args, str)
			}
		}
	}
	if env, ok := raw["env"].(map[string]any); ok {
		server.Env = map[string]string{}
		for k, v := range env {
			if str, ok := v.(string); ok {
				server.Env[k] = str
			}
		}
	}
	if headers, ok := raw["headers"].(map[string]any); ok {
		server.Headers = map[string]string{}
		for k, v := range headers {
			if str, ok := v.(string); ok {
				server.Headers[k] = str
			}
		}
	}
	if timeout, ok := raw["timeout"].(string); ok {
		server.Timeout = timeout
	}
	if denied, ok := raw["disallowedTools"].([]any); ok {
		for _, name := range denied {
			if text, ok := name.(string); ok {
				server.DisallowedTools = append(server.DisallowedTools, text)
			}
		}
	}
	return server
}

// mcpView 返回合并后按名称排序的服务器列表。
func (s *Controller) mcpView() []McpServer {
	s.mcpLoad()
	s.mcp.mu.Lock()
	defer s.mcp.mu.Unlock()
	out := append([]McpServer(nil), s.mcp.native...)
	merged := map[string]McpServer{}
	for _, server := range out {
		merged[server.Name] = server
	}
	for _, raw := range s.mcp.external {
		server := externalToServer(raw)
		merged[server.Name] = server
	}
	out = []McpServer{}
	for _, server := range merged {
		out = append(out, server)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// mcpUpsert 新增或替换服务器条目（支持重命名）。
func (s *Controller) mcpUpsert(originalName string, server McpServer) {
	s.mcpLoad()
	s.mcp.mu.Lock()
	defer s.mcp.mu.Unlock()
	if originalName != "" && originalName != server.Name {
		s.mcp.removeLocked(originalName)
	}
	s.mcp.removeLocked(server.Name)
	s.mcp.native = append(s.mcp.native, server)
}

func (st *mcpStore) removeLocked(name string) {
	next := st.native[:0]
	for _, srv := range st.native {
		if srv.Name != name {
			next = append(next, srv)
		}
	}
	st.native = next
	delete(st.external, name)
}

// mcpController 分发 /api/mcp。
func (s *Controller) mcpController(w http.ResponseWriter, r *http.Request) {
	action := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/mcp"), "/")
	if action == "servers" || strings.HasPrefix(action, "servers/") {
		s.mcpServers(w, r, strings.Trim(strings.TrimPrefix(action, "servers"), "/"))
		return
	}
	switch action {
	case "export", "export/refresh":
		s.mcpExport(w, r)
	case "tunnel", "tunnel/config", "tunnel/start", "tunnel/stop":
		s.mcpTunnel(w, r, action)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) mcpServers(w http.ResponseWriter, r *http.Request, action string) {
	switch action {
	case "":
		writeOK(w, http.StatusOK, s.mcpView())
	case "add":
		body, _ := io.ReadAll(r.Body)
		var server McpServer
		if err := json.Unmarshal(body, &server); err != nil {
			writeFail(w, http.StatusBadRequest, "服务器配置格式不正确")
			return
		}
		if err := server.validate(); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		if !explicitEnabled(body) {
			server.Enabled = true
		}
		s.mcpUpsert("", server)
		s.mcpPersist()
		writeOK(w, http.StatusOK, server)
	case "update":
		var body struct {
			OriginalName string    `json:"originalName"`
			Server       McpServer `json:"server"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeFail(w, http.StatusBadRequest, "服务器配置格式不正确")
			return
		}
		if err := body.Server.validate(); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		original := body.OriginalName
		if original == "" {
			original = body.Server.Name
		}
		if _, exists := s.mcpFind(original); !exists {
			writeFail(w, http.StatusBadRequest, "服务器不存在: "+original)
			return
		}
		s.mcpUpsert(original, body.Server)
		s.mcpPersist()
		writeOK(w, http.StatusOK, body.Server)
	case "remove":
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, ok := s.mcpFind(body.Name); !ok {
			writeFail(w, http.StatusBadRequest, "服务器不存在: "+body.Name)
			return
		}
		s.mcpLoad()
		s.mcp.mu.Lock()
		s.mcp.removeLocked(body.Name)
		s.mcp.mu.Unlock()
		s.mcpPersist()
		writeOK(w, http.StatusOK, "服务器已删除")
	case "toggle":
		var body struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		server, ok := s.mcpFind(body.Name)
		if !ok {
			writeFail(w, http.StatusBadRequest, "服务器不存在: "+body.Name)
			return
		}
		server.Enabled = body.Enabled
		s.mcpUpsert(body.Name, server)
		s.mcpPersist()
		writeOK(w, http.StatusOK, server)
	case "check":
		var body McpServer
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
			writeFail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if _, err := mcpListTools(ctx, body); err != nil {
			writeFail(w, http.StatusBadRequest, "连接失败，请检查服务器配置")
			return
		}
		writeOK(w, http.StatusOK, "连接成功")
	case "tools":
		name := r.URL.Query().Get("name")
		if name == "" {
			writeFail(w, http.StatusBadRequest, "name 必填")
			return
		}
		server, ok := s.mcpFind(name)
		if !ok {
			writeFail(w, http.StatusBadRequest, "服务器不存在: "+name)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		tools, err := mcpListTools(ctx, server)
		denied := append([]string{}, server.DisallowedTools...)
		if err != nil {
			writeOK(w, http.StatusOK, map[string]any{
				"connected": false, "tools": []any{}, "disallowedTools": denied,
			})
			return
		}
		writeOK(w, http.StatusOK, map[string]any{
			"connected": true, "tools": tools, "disallowedTools": denied,
		})
	case "tools/save":
		var body struct {
			ServerName      string   `json:"serverName"`
			DisallowedTools []string `json:"disallowedTools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ServerName == "" {
			writeFail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
		server, ok := s.mcpFind(body.ServerName)
		if !ok {
			writeFail(w, http.StatusBadRequest, "服务器不存在: "+body.ServerName)
			return
		}
		server.DisallowedTools = body.DisallowedTools
		s.mcpUpsert(body.ServerName, server)
		s.mcpPersist()
		writeOK(w, http.StatusOK, "工具权限已保存")
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) mcpFind(name string) (McpServer, bool) {
	for _, srv := range s.mcpView() {
		if srv.Name == name {
			return srv, true
		}
	}
	return McpServer{}, false
}

// McpExportConfig 对应 ~/.loopra/mcp-server.json（单数形式）。
type McpExportConfig struct {
	Enabled      *bool    `json:"enabled"`
	Name         string   `json:"name"`
	Version      string   `json:"version"`
	Channel      string   `json:"channel"` // streamable | streamable_stateless | sse
	Endpoint     string   `json:"endpoint"`
	AllowedTools []string `json:"allowedTools"`
}

func (s *Controller) mcpExportPath() string {
	return filepath.Join(s.home, "mcp-server.json")
}

func (s *Controller) mcpExportLoad() McpExportConfig {
	cfg := McpExportConfig{Name: "loopra", Version: "1.0.0", Channel: "streamable", Endpoint: "/mcp"}
	if data, err := os.ReadFile(s.mcpExportPath()); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func (s *Controller) mcpExport(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPut:
		var cfg McpExportConfig
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			writeFail(w, http.StatusBadRequest, "配置格式不正确")
			return
		}
		if cfg.Name == "" {
			cfg.Name = "loopra"
		}
		if cfg.Version == "" {
			cfg.Version = "1.0.0"
		}
		if cfg.Channel == "" {
			cfg.Channel = "streamable"
		}
		if cfg.Endpoint == "" {
			cfg.Endpoint = "/mcp"
		}
		if cfg.Endpoint == "/" || !strings.HasPrefix(cfg.Endpoint, "/") || strings.HasPrefix(cfg.Endpoint, "/api") || strings.ContainsAny(cfg.Endpoint, "?#\\") || strings.Contains(cfg.Endpoint, "..") {
			writeFail(w, http.StatusBadRequest, "无效的 MCP endpoint")
			return
		}
		if cfg.Channel != "streamable" && cfg.Channel != "streamable_stateless" && cfg.Channel != "sse" {
			writeFail(w, http.StatusBadRequest, "无效的 MCP channel")
			return
		}
		if err := repository.WriteJSON(s.mcpExportPath(), cfg); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		view := s.mcpExportView(cfg)
		view["endpointUrl"] = "http://" + r.Host + cfg.Endpoint
		s.resetMcpExport()
		writeOK(w, http.StatusOK, view)
	default:
		cfg := s.mcpExportLoad()
		if strings.HasSuffix(r.URL.Path, "/refresh") {
			s.resetMcpExport()
		}
		view := s.mcpExportView(cfg)
		view["endpointUrl"] = "http://" + r.Host + cfg.Endpoint
		writeOK(w, http.StatusOK, view)
	}
}

func (s *Controller) mcpExportView(cfg McpExportConfig) map[string]any {
	enabled := cfg.Enabled != nil && *cfg.Enabled
	entries := []map[string]any{}
	if s.registry != nil {
		for _, entry := range s.registry.List() {
			name := entry["name"].(string)
			exposed := entry["enabled"] == true && (cfg.AllowedTools == nil || containsString(cfg.AllowedTools, name))
			entries = append(entries, map[string]any{"name": name, "description": entry["description"], "readOnly": entry["readOnly"], "enabled": entry["enabled"], "exposed": exposed})
		}
	}
	view := map[string]any{
		"enabled": enabled, "name": cfg.Name, "version": cfg.Version,
		"channel": cfg.Channel, "endpoint": cfg.Endpoint,
		"tools":       entries,
		"endpointUrl": "http://127.0.0.1" + cfg.Endpoint,
	}
	if cfg.AllowedTools != nil {
		view["allowedTools"] = cfg.AllowedTools
	}
	return view
}

// mcpTunnel 管理 cloudflared 及其仅暴露端点的本地代理。
func (s *Controller) mcpTunnel(w http.ResponseWriter, r *http.Request, action string) {
	s.tunnelController(w, r, action)
}

func (s *Controller) tunnelConfigPath() string {
	return filepath.Join(s.home, "cloudflare-tunnel.json")
}

// detectCloudflared 解析可执行文件：先查配置文件，再查环境变量覆盖，
// 最后查 PATH（对应 Java 的 CloudflareTunnelService.resolveExecutable）。
func detectCloudflared(s *Controller) string {
	if data, err := os.ReadFile(s.tunnelConfigPath()); err == nil {
		var cfg struct {
			ExecutablePath string `json:"executablePath"`
		}
		if json.Unmarshal(data, &cfg) == nil && cfg.ExecutablePath != "" {
			if _, err := os.Stat(cfg.ExecutablePath); err == nil {
				return cfg.ExecutablePath
			}
		}
	}
	if p := os.Getenv("CLOUDFLARED_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	name := "cloudflared"
	if runtime.GOOS == "windows" {
		name = "cloudflared.exe"
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

// mcpListTools 通过 ADK MCP 工具集拨通一个已配置的服务器，
// 并返回其工具声明（name + description）。
func mcpListTools(ctx context.Context, server McpServer) ([]map[string]any, error) {
	cfg := mcpClientConfig(server)
	set, err := mcptoolset.New(cfg)
	if err != nil {
		return nil, err
	}
	if closer, ok := set.(interface{ Close() error }); ok {
		defer closer.Close()
	}
	tools, err := set.Tools(readonlyCtx(ctx))
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		entry := map[string]any{"name": t.Name(), "description": t.Description()}
		out = append(out, entry)
	}
	return out, nil
}

func envPairs(env map[string]string) []string {
	pairs := make([]string, 0, len(env))
	for k, v := range env {
		pairs = append(pairs, k+"="+v)
	}
	return pairs
}

// readonlyCtx 将普通 context 适配为 MCP 工具集所需的
// agent.ReadonlyContext（仅读取 deadline 和 values）。
type readonlyOnlyCtx struct{ context.Context }

func (readonlyOnlyCtx) InvocationID() string                 { return "" }
func (readonlyOnlyCtx) AgentName() string                    { return "" }
func (readonlyOnlyCtx) UserContent() *genai.Content          { return nil }
func (readonlyOnlyCtx) UserID() string                       { return "default" }
func (readonlyOnlyCtx) AppName() string                      { return "loopra" }
func (readonlyOnlyCtx) SessionID() string                    { return "" }
func (readonlyOnlyCtx) Branch() string                       { return "" }
func (readonlyOnlyCtx) ReadonlyState() session.ReadonlyState { return nil }

func readonlyCtx(ctx context.Context) agentpkg.ReadonlyContext {
	return readonlyOnlyCtx{Context: ctx}
}

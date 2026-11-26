package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// EventKind 标识一次 ACP 会话更新被转换后的类型。
type EventKind string

const (
	EventContent  EventKind = "content"
	EventReason   EventKind = "reasoning"
	EventToolCall EventKind = "tool_call"
	EventPlan     EventKind = "plan"
	EventCommands EventKind = "commands"
	EventConfig   EventKind = "config"
	EventMode     EventKind = "mode"
	EventUsage    EventKind = "usage"
	EventNative   EventKind = "native"
	// 原生子会话（Codex）：subagent_spawned / subagent_state_update。
	EventSubSpawned EventKind = "sub_spawned"
	EventSubState   EventKind = "sub_state"
)

// Event 是交给上层的单条会话更新。
type Event struct {
	// SDK notifications are converted by the turn worker, never on the SDK's
	// serial notification goroutine.
	notification  *acpsdk.SessionNotification
	source        *Client
	Kind          EventKind
	Text          string
	Tool          *SessionUpdate
	Plan          []PlanEntry
	Commands      []Command
	ConfigOptions []ConfigOption
	Mode          string
	Used          int64
	Size          int64
	Cost          *UsageCost
	Model         string
	NativeType    string
	NativeData    json.RawMessage
	Meta          map[string]any
	// SubSession 是该更新所属的原生子会话 id（Codex child session）。
	SubSession string
	// Subagent 是 subagent_spawned / subagent_state_update 的原始载荷。
	Subagent *SessionUpdate
}

// ParentToolUseID 返回该更新所属的父级工具调用（子代理）。
func (e Event) ParentToolUseID() string {
	if e.Meta == nil {
		return ""
	}
	if value, ok := e.Meta["parentToolUseId"].(string); ok {
		return value
	}
	if claude, ok := e.Meta["claudeCode"].(map[string]any); ok {
		if value, ok := claude["parentToolUseId"].(string); ok {
			return value
		}
	}
	return ""
}

// Handler 接收会话更新；实现方不得阻塞。
type Handler func(Event)

// PermissionFunc 处理 Agent 的权限请求，返回选中的 optionId；
// ok 为 false 时按取消处理。
type PermissionFunc func(ctx context.Context, request PermissionRequest) (string, bool)

// ElicitationFunc 处理 Agent 的反向提问（表单）。
type ElicitationFunc func(ctx context.Context, request ElicitationRequest) ElicitationResult

// Client 是 coder/acp-go-sdk 之上的 Loopra 会话客户端。
// 线上协议由 SDK 负责，这里只保留 Loopra 的事件和配置形状。
type Client struct {
	conn *acpsdk.ClientSideConnection
	proc *agentProcess

	handler Handler
	perm    PermissionFunc
	elicit  ElicitationFunc
	// owner 是当前占用这条连接的 Loopra 会话。同一工作区的多个会话
	// 可以共用一个进程；事件和权限请求交给 owner，而不是创建连接时的回调。
	owner *Conn
	// accepting 为 true 时，会话建立过程中的更新不再按旧 session id 丢弃。
	accepting bool
	// sessionConns / toolSessions 把 ACP session 和 tool call 映射回
	// 属主会话。共享进程时 owner 会被别的会话切走，elicitation、
	// permission 和 session/update 必须按请求自身携带的会话身份路由。
	sessionConns map[string]*Conn
	toolSessions map[string]string

	mu              sync.Mutex
	disconnectErr   error
	initialized     AgentCapabilities
	authMethods     []string
	sessionID       string
	configOptions   []ConfigOption
	nativeEvents    bool
	configSupported bool
	// replaying 期间丢弃历史重放产生的会话更新，避免把旧对话
	// 当成新一轮的流式输出。
	replaying bool
	// 原生子会话（Codex）：wanted 由调用方按引擎开启，
	// supported 来自 initialize 的会话能力，
	// children 记录已登记的子会话 id。
	childWanted    bool
	childSupported bool
	children       map[string]bool
	// servers 是会话建立时透传给 Agent 的 MCP 定义。
	servers []any
	// 重放期间收到的 plan/config：不产生流式事件，
	// 但仍需持久化到会话元数据（Java 只抑制 SSE）。
	replayPlan   []PlanEntry
	replayConfig []ConfigOption
	// Command broadcasts outlive turns and are scoped to the remote session.
	commandsBySession map[string][]Command
}

var _ acpsdk.Client = (*Client)(nil)

// NewClient 启动 ACP 进程并完成 SDK 连接（但不做 initialize）。
func NewClient(launch Launch, cwd string, handler Handler, perm PermissionFunc) (*Client, error) {
	proc, err := startAgentProcess(launch.Command, launch.Env, cwd)
	if err != nil {
		return nil, err
	}
	client := &Client{proc: proc, handler: handler, perm: perm, children: map[string]bool{},
		sessionConns: map[string]*Conn{}, toolSessions: map[string]string{}}
	client.conn = acpsdk.NewClientSideConnection(client, proc.stdin, proc.stdout)
	client.conn.SetLogger(slog.New(connectionLog{Handler: logging.LibraryLogger().Handler(), client: client}))
	return client, nil
}

// SetElicitationHandler 注册 Agent 反向提问处理器。
func (c *Client) SetElicitationHandler(fn ElicitationFunc) {
	c.mu.Lock()
	c.elicit = fn
	c.mu.Unlock()
}

// focus 把后续协议调用和事件切到指定 Loopra 会话。
func (c *Client) focus(owner *Conn, sessionID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.owner = owner
	if sessionID != "" {
		c.sessionID = sessionID
		if c.sessionConns == nil {
			c.sessionConns = map[string]*Conn{}
		}
		c.sessionConns[sessionID] = owner
	}
	c.mu.Unlock()
}

// beginAccept 在 session/new、load、resume、fork 期间接收任意会话的更新。
func (c *Client) beginAccept(owner *Conn) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.owner = owner
	c.accepting = true
	c.mu.Unlock()
}

// endAccept 结束会话建立，并记下该 Loopra 会话对应的 ACP session id。
// sessionConns 的索引交给 BindSession：beginAccept/endAccept 之间 owner
// 可能已被别的会话切走，这里不能用 c.owner 反推属主。
func (c *Client) endAccept(sessionID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.accepting = false
	for id := range c.commandsBySession {
		if c.sessionConns[id] == nil {
			delete(c.commandsBySession, id)
		}
	}
	if sessionID != "" {
		c.sessionID = sessionID
	}
	c.mu.Unlock()
}

func (c *Client) clearOwner(owner *Conn) {
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.owner == owner {
		c.owner = nil
	}
	for sessionID, conn := range c.sessionConns {
		if conn == owner {
			delete(c.sessionConns, sessionID)
			delete(c.commandsBySession, sessionID)
			for tool, sid := range c.toolSessions {
				if sid == sessionID {
					delete(c.toolSessions, tool)
				}
			}
		}
	}
	c.mu.Unlock()
}

// indexSession 绑定 ACP session id 到属主连接；focus、endAccept 和
// Conn.BindSession 是各条学习到绑定的路径。
func (c *Client) indexSession(sessionID string, conn *Conn) {
	if c == nil || sessionID == "" || conn == nil {
		return
	}
	c.mu.Lock()
	if c.sessionConns == nil {
		c.sessionConns = map[string]*Conn{}
	}
	c.sessionConns[sessionID] = conn
	c.mu.Unlock()
}

// indexToolSession 记录 tool call 属于哪个 ACP session。
// elicitation/create 不带 sessionId（ACP 未稳定协议缺口），
// 只能靠 meta 里的 toolCallId 经它找回属主。
func (c *Client) indexToolSession(toolCallID, sessionID string) {
	if toolCallID == "" || sessionID == "" {
		return
	}
	c.mu.Lock()
	if c.toolSessions == nil {
		c.toolSessions = map[string]string{}
	}
	if len(c.toolSessions) >= 16384 {
		// 病态防御：索引只服务进行中的工具调用，溢出时整体重建，
		// 代价是极个别请求退回 owner。
		c.toolSessions = map[string]string{}
	}
	c.toolSessions[toolCallID] = sessionID
	c.mu.Unlock()
}

// toolSessionOwner 经 toolCallId 找到属主连接，没有索引返回 nil。
func (c *Client) toolSessionOwner(toolCallID string) *Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	if session, ok := c.toolSessions[toolCallID]; ok {
		return c.sessionConns[session]
	}
	return nil
}

// requestOwner 按请求自带的身份选择属主连接：toolCallId 最精确，
// sessionId 次之，都对不上时退回当前 owner（与旧行为一致）。
func (c *Client) requestOwner(sessionID, toolCallID string) *Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	if toolCallID != "" {
		if session, ok := c.toolSessions[toolCallID]; ok {
			if conn := c.sessionConns[session]; conn != nil {
				return conn
			}
		}
	}
	if sessionID != "" {
		if conn := c.sessionConns[sessionID]; conn != nil {
			return conn
		}
	}
	return c.owner
}

// bindOwnerOptions 把进程上最近的配置抄到当前 Loopra 会话。
// 共用进程时，客户端自己的配置项只反映最后一次操作的会话。
func (c *Client) bindOwnerOptions(options []ConfigOption) {
	if c == nil || options == nil {
		return
	}
	c.mu.Lock()
	owner := c.owner
	id := c.sessionID
	c.mu.Unlock()
	if owner != nil {
		owner.BindSession(id, options)
	}
}

// EnableChildSessions 在 initialize 时声明 subagents 客户端能力，
// 使 Codex 之类的 Agent 把原生子会话更新推给本客户端。
func (c *Client) EnableChildSessions(enabled bool) {
	c.mu.Lock()
	c.childWanted = enabled
	c.mu.Unlock()
}

// ChildSessionsSupported 报告 Agent 是否接受原生子会话。
func (c *Client) ChildSessionsSupported() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.childSupported
}

// Initialize 执行 ACP 握手并校验协议版本。
func (c *Client) Initialize(ctx context.Context, version string) error {
	c.mu.Lock()
	wanted := c.childWanted
	c.mu.Unlock()
	meta := map[string]any{
		"loopra.dev/workbench":  true,
		"subagent-transcript":   true,
		"terminal_output_delta": true,
	}
	if wanted {
		meta["subagents"] = map[string]any{}
	}
	result, err := c.conn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientCapabilities: acpsdk.ClientCapabilities{
			Elicitation: &acpsdk.ElicitationCapabilities{Form: &acpsdk.ElicitationFormCapabilities{}},
			Meta:        meta,
		},
		ClientInfo: &acpsdk.Implementation{
			Name: ClientName, Version: version, Title: acpsdk.Ptr("Loopra Workbench"),
		},
	})
	if err != nil {
		return c.fail(err)
	}
	if result.ProtocolVersion != acpsdk.ProtocolVersionNumber {
		return fmt.Errorf("Agent did not negotiate ACP v1")
	}
	caps := localCapabilities(result.AgentCapabilities)
	c.mu.Lock()
	c.initialized = caps
	c.authMethods = authMethodIDs(result.AuthMethods)
	c.nativeEvents = caps.Meta != nil && caps.Meta["loopra.dev/workbench"] == true
	c.childSupported = false
	if wanted && caps.SessionCapabilities != nil {
		if _, ok := caps.SessionCapabilities["subagents"]; ok {
			c.childSupported = true
		}
	}
	c.mu.Unlock()
	logging.Debugf("acp", "initialized protocol=%d loadSession=%v nativeEvents=%v agent=%q",
		result.ProtocolVersion, caps.LoadSession, c.nativeEvents, agentTitle(result.AgentInfo))
	return nil
}

// authMethodIDs 从 initialize 广播的认证方法里取出方法 id
// （SDK 的 AuthMethod 是 union，常规方法在 Agent 变体里）。
func authMethodIDs(methods []acpsdk.AuthMethod) []string {
	var ids []string
	for _, method := range methods {
		switch {
		case method.Agent != nil:
			ids = append(ids, method.Agent.Id)
		case method.EnvVar != nil:
			ids = append(ids, method.EnvVar.Id)
		case method.Terminal != nil:
			ids = append(ids, method.Terminal.Id)
		}
	}
	return ids
}

// authRetry 处理 Agent 的 -32000（要求先 authenticate）错误：
// 用其广播的第一个认证方法完成一次 authenticate，返回 true 表示
// 调用方应原样重试。Devin 等 Agent 在 ACP 下不复用 CLI 本地凭据，
// 首次会拉起浏览器 PKCE，认证结果由 Agent 自行持久化。
func (c *Client) authRetry(ctx context.Context, err error) bool {
	var requestErr *acpsdk.RequestError
	if !errors.As(err, &requestErr) || requestErr.Code != -32000 {
		return false
	}
	c.mu.Lock()
	methods := append([]string(nil), c.authMethods...)
	c.mu.Unlock()
	if len(methods) == 0 {
		return false
	}
	logging.Infof("acp", "agent requires authentication, calling authenticate method=%s", methods[0])
	if _, authErr := c.conn.Authenticate(ctx, acpsdk.AuthenticateRequest{MethodId: methods[0]}); authErr != nil {
		logging.Warnf("acp", "authenticate method=%s failed: %v", methods[0], authErr)
		return false
	}
	return true
}

// Authenticate 用 Agent 广播的第一个认证方法执行 authenticate；
// meta 原样作为 _meta 传回（Devin 的 _meta.api_key）。
func (c *Client) Authenticate(ctx context.Context, meta map[string]any) error {
	c.mu.Lock()
	methods := append([]string(nil), c.authMethods...)
	c.mu.Unlock()
	if len(methods) == 0 {
		return errors.New("Agent 未提供认证方法")
	}
	_, err := c.conn.Authenticate(ctx, acpsdk.AuthenticateRequest{MethodId: methods[0], Meta: meta})
	if err != nil {
		return c.fail(err)
	}
	return nil
}

func agentTitle(info *acpsdk.Implementation) string {
	if info == nil {
		return "unknown"
	}
	if info.Title != nil && *info.Title != "" {
		return *info.Title
	}
	return info.Name
}

// Capabilities 返回 Agent 能力。
func (c *Client) Capabilities() AgentCapabilities {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.initialized
}

// NativeEvents 报告 Agent 是否支持 loopra.dev 扩展事件。
func (c *Client) NativeEvents() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nativeEvents
}

// SetMcpServers 设置会话建立时透传的 MCP 服务器定义。
func (c *Client) SetMcpServers(servers []any) {
	c.mu.Lock()
	c.servers = servers
	c.mu.Unlock()
}

// McpPayload 返回待透传的 MCP 定义（始终是非 nil 数组）。
func (c *Client) McpPayload() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.servers == nil {
		return []any{}
	}
	return c.servers
}

// SupportedMCP 留下该 Agent 声明能够连接的 MCP。
// 未声明 HTTP/SSE 时跳过对应服务，避免一次可选配置挡住整个 Agent 选择。
func (c *Client) SupportedMCP(servers []any) []any {
	return supportedMCP(c.Capabilities(), servers)
}

func supportedMCP(caps AgentCapabilities, servers []any) []any {
	out := make([]any, 0, len(servers))
	for _, raw := range servers {
		server, _ := raw.(map[string]any)
		kind, _ := server["type"].(string)
		name, _ := server["name"].(string)
		switch kind {
		case "http":
			if caps.MCPCapabilities == nil || caps.MCPCapabilities["http"] != true {
				logging.Warnf("acp", "跳过 HTTP MCP %s：当前 Agent 未声明支持", name)
				continue
			}
		case "sse":
			if caps.MCPCapabilities == nil || caps.MCPCapabilities["sse"] != true {
				logging.Warnf("acp", "跳过 SSE MCP %s：当前 Agent 未声明支持", name)
				continue
			}
		}
		out = append(out, raw)
	}
	return out
}

// NewSession 建立新的 Agent 会话。
func (c *Client) NewSession(ctx context.Context, cwd string, dirs []string) (SessionSetupResult, error) {
	servers, err := sdkMCP(c.McpPayload())
	if err != nil {
		return SessionSetupResult{}, err
	}
	request := acpsdk.NewSessionRequest{
		Cwd: cwd, McpServers: servers, AdditionalDirectories: dirs,
	}
	raw, err := c.conn.NewSession(ctx, request)
	if err != nil && c.authRetry(ctx, err) {
		raw, err = c.conn.NewSession(ctx, request)
	}
	if err != nil {
		return SessionSetupResult{}, c.fail(err)
	}
	result := setupFromNew(raw)
	if strings.TrimSpace(result.SessionID) == "" {
		return SessionSetupResult{}, fmt.Errorf("Agent returned an empty session ID")
	}
	c.mu.Lock()
	c.sessionID = result.SessionID
	c.mu.Unlock()
	c.applySetup(&result)
	logging.Debugf("acp", "session new id=%s options=%d", result.SessionID, len(c.ConfigOptions()))
	return result, nil
}

// LoadSession 恢复已有会话并重放历史（重放期间不产生新的流式事件）。
func (c *Client) LoadSession(ctx context.Context, sessionID, cwd string, dirs []string) (SessionSetupResult, error) {
	c.setReplaying(true)
	defer c.setReplaying(false)
	servers, err := sdkMCP(c.McpPayload())
	if err != nil {
		return SessionSetupResult{}, err
	}
	request := acpsdk.LoadSessionRequest{
		SessionId: acpsdk.SessionId(sessionID), Cwd: cwd, McpServers: servers, AdditionalDirectories: dirs,
	}
	raw, err := c.conn.LoadSession(ctx, request)
	if err != nil && c.authRetry(ctx, err) {
		raw, err = c.conn.LoadSession(ctx, request)
	}
	if err != nil {
		return SessionSetupResult{}, c.fail(err)
	}
	result := SessionSetupResult{SessionID: sessionID, ConfigOptions: configFromSDK(raw.ConfigOptions), Modes: modesFromSDK(raw.Modes)}
	c.mu.Lock()
	c.sessionID = sessionID
	c.mu.Unlock()
	c.applySetup(&result)
	logging.Debugf("acp", "session load id=%s options=%d", sessionID, len(c.ConfigOptions()))
	return result, nil
}

// ResumeSession 恢复会话但不重放历史（仅支持 resume 的 Agent）。
func (c *Client) ResumeSession(ctx context.Context, sessionID, cwd string, dirs []string) (SessionSetupResult, error) {
	c.setReplaying(true)
	defer c.setReplaying(false)
	servers, err := sdkMCP(c.McpPayload())
	if err != nil {
		return SessionSetupResult{}, err
	}
	request := acpsdk.ResumeSessionRequest{
		SessionId: acpsdk.SessionId(sessionID), Cwd: cwd, McpServers: servers, AdditionalDirectories: dirs,
	}
	raw, err := c.conn.ResumeSession(ctx, request)
	if err != nil && c.authRetry(ctx, err) {
		raw, err = c.conn.ResumeSession(ctx, request)
	}
	if err != nil {
		return SessionSetupResult{}, c.fail(err)
	}
	result := SessionSetupResult{SessionID: sessionID, ConfigOptions: configFromSDK(raw.ConfigOptions), Modes: modesFromSDK(raw.Modes)}
	c.mu.Lock()
	c.sessionID = sessionID
	c.mu.Unlock()
	c.applySetup(&result)
	logging.Debugf("acp", "session resume id=%s options=%d", sessionID, len(c.ConfigOptions()))
	return result, nil
}

// ForkSession 基于已有会话创建分叉（session/fork）。
func (c *Client) ForkSession(ctx context.Context, sourceID, cwd string, dirs []string, meta map[string]any) (string, error) {
	capabilities := c.Capabilities()
	if capabilities.SessionCapabilities == nil {
		return "", fmt.Errorf("当前 Agent 不支持创建会话分叉")
	}
	if _, supported := capabilities.SessionCapabilities["fork"]; !supported {
		return "", fmt.Errorf("当前 Agent 不支持创建会话分叉")
	}
	servers, err := sdkMCP(c.McpPayload())
	if err != nil {
		return "", err
	}
	request := acpsdk.UnstableForkSessionRequest{
		SessionId: acpsdk.SessionId(sourceID), Cwd: cwd, AdditionalDirectories: dirs, Meta: meta,
		McpServers: unstableMCP(servers),
	}
	raw, err := c.conn.UnstableForkSession(ctx, request)
	if err != nil && c.authRetry(ctx, err) {
		raw, err = c.conn.UnstableForkSession(ctx, request)
	}
	if err != nil {
		return "", c.fail(err)
	}
	id := string(raw.SessionId)
	if strings.TrimSpace(id) == "" || id == sourceID {
		return "", fmt.Errorf("Agent 返回了无效的分叉会话")
	}
	result := SessionSetupResult{SessionID: id, Modes: modesFromSDK(raw.Modes), ConfigOptions: forkConfigOptions(raw.ConfigOptions)}
	c.mu.Lock()
	c.sessionID = id
	c.mu.Unlock()
	c.applySetup(&result)
	logging.Debugf("acp", "session fork source=%s id=%s", sourceID, id)
	return id, nil
}

// applySetup 记录会话建立时返回的配置项；旧版 Agent 只给
// modes，这里合成为同形状的配置项供前端渲染。
func (c *Client) applySetup(result *SessionSetupResult) {
	c.mu.Lock()
	if len(result.ConfigOptions) > 0 {
		c.configOptions = result.ConfigOptions
		c.configSupported = true
	} else {
		c.configOptions = legacyConfigOptions(result.Modes, result.Models)
	}
	options := append([]ConfigOption(nil), c.configOptions...)
	c.mu.Unlock()
	c.bindOwnerOptions(options)
}

// legacyConfigOptions 把 ACP 旧版的 modes/models 转成配置项。
func legacyConfigOptions(modes *SessionModes, models *SessionModels) []ConfigOption {
	options := []ConfigOption{}
	if modes != nil && len(modes.AvailableModes) > 0 {
		values := make([]ConfigOptionValue, 0, len(modes.AvailableModes))
		for _, mode := range modes.AvailableModes {
			values = append(values, ConfigOptionValue{Value: mode.ID, Name: mode.Name, Description: mode.Description})
		}
		options = append(options, ConfigOption{
			ID: "mode", Name: "模式", Category: "mode", Type: "select",
			CurrentValue: modes.CurrentModeID, Options: values,
		})
	}
	if models != nil && len(models.AvailableModels) > 0 {
		values := make([]ConfigOptionValue, 0, len(models.AvailableModels))
		for _, model := range models.AvailableModels {
			values = append(values, ConfigOptionValue{Value: model.ModelID, Name: model.Name, Description: model.Description})
		}
		options = append(options, ConfigOption{
			ID: "model", Name: "模型", Category: "model", Type: "select",
			CurrentValue: models.CurrentModelID, Options: values,
		})
	}
	return options
}

// ConfigOptionsSupported 报告 Agent 是否原生支持 configOptions。
func (c *Client) ConfigOptionsSupported() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.configSupported
}

func (c *Client) setReplaying(value bool) {
	c.mu.Lock()
	c.replaying = value
	c.mu.Unlock()
}

// SessionID 返回当前 Agent 会话 ID。
func (c *Client) SessionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionID
}

// ConfigOptions 返回最近一次已知的配置项。
func (c *Client) ConfigOptions() []ConfigOption {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ConfigOption(nil), c.configOptions...)
}

// Prompt 发送一条用户消息并阻塞到本轮结束。
func (c *Client) Prompt(ctx context.Context, blocks []ContentBlock) (PromptResult, error) {
	sessionID := c.SessionID()
	if sessionID == "" {
		return PromptResult{}, fmt.Errorf("Agent 会话正在初始化")
	}
	logging.Debugf("acp", "prompt session=%s blocks=%d", sessionID, len(blocks))
	raw, err := c.conn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: acpsdk.SessionId(sessionID), Prompt: sdkBlocks(blocks),
	})
	if err != nil {
		return PromptResult{}, c.fail(err)
	}
	if raw.StopReason == "" {
		return PromptResult{}, fmt.Errorf("Agent 未返回回合结束原因")
	}
	return PromptResult{StopReason: string(raw.StopReason)}, nil
}

// Cancel 请求 Agent 取消当前回合。
func (c *Client) Cancel(ctx context.Context) error {
	sessionID := c.SessionID()
	if sessionID == "" {
		return nil
	}
	return c.fail(c.conn.Cancel(ctx, acpsdk.CancelNotification{SessionId: acpsdk.SessionId(sessionID)}))
}

// SetConfigOption 更新一个会话配置项。
func (c *Client) SetConfigOption(ctx context.Context, id string, value any) ([]ConfigOption, error) {
	sessionID := c.SessionID()
	if sessionID == "" {
		return nil, fmt.Errorf("Agent 会话正在初始化")
	}
	request := acpsdk.SetSessionConfigOptionRequest{}
	if flag, ok := value.(bool); ok {
		request.Boolean = &acpsdk.SetSessionConfigOptionBoolean{
			SessionId: acpsdk.SessionId(sessionID), ConfigId: acpsdk.SessionConfigId(id), Type: "boolean", Value: flag,
		}
	} else {
		request.ValueId = &acpsdk.SetSessionConfigOptionValueId{
			SessionId: acpsdk.SessionId(sessionID), ConfigId: acpsdk.SessionConfigId(id),
			Value: acpsdk.SessionConfigValueId(fmt.Sprint(value)),
		}
	}
	raw, err := c.conn.SetSessionConfigOption(ctx, request)
	if err != nil {
		return nil, c.fail(err)
	}
	c.mu.Lock()
	if len(raw.ConfigOptions) > 0 {
		c.configOptions = configFromSDK(raw.ConfigOptions)
		c.configSupported = true
	} else {
		for index := range c.configOptions {
			if c.configOptions[index].ID == id {
				c.configOptions[index].CurrentValue = value
			}
		}
	}
	options := append([]ConfigOption(nil), c.configOptions...)
	c.mu.Unlock()
	c.bindOwnerOptions(options)
	return options, nil
}

// SetMode 切换会话模式。
func (c *Client) SetMode(ctx context.Context, mode string) error {
	sessionID := c.SessionID()
	if sessionID == "" {
		return fmt.Errorf("Agent 会话正在初始化")
	}
	if _, err := c.conn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{
		SessionId: acpsdk.SessionId(sessionID), ModeId: acpsdk.SessionModeId(mode),
	}); err != nil {
		return c.fail(err)
	}
	c.updateValue("mode", mode)
	c.bindOwnerOptions(c.ConfigOptions())
	return nil
}

// SetModel 切换会话模型。当前 SDK 没有 session/set_model，
// 模型通过 session/set_config_option 的 model 项设置。
func (c *Client) SetModel(ctx context.Context, model string) error {
	if _, err := c.SetConfigOption(ctx, "model", model); err != nil {
		return err
	}
	return nil
}

// updateValue 在旧版模式下同步本地配置项的当前值。
func (c *Client) updateValue(id string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for index := range c.configOptions {
		if c.configOptions[index].ID == id {
			c.configOptions[index].CurrentValue = value
		}
	}
}

// Close 结束连接并回收进程树。
func (c *Client) Close() error {
	if c == nil || c.proc == nil {
		return nil
	}
	return c.proc.Close()
}

// Alive 报告底层进程是否仍可用。
func (c *Client) Alive() bool {
	if c == nil || !c.proc.Alive() {
		return false
	}
	if c.conn != nil {
		select {
		case <-c.conn.Done():
			return false
		default:
		}
	}
	return true
}

func (c *Client) fail(err error) error {
	if err == nil {
		return nil
	}
	if c.conn != nil {
		select {
		case <-c.conn.Done():
			c.mu.Lock()
			cause := c.disconnectErr
			c.mu.Unlock()
			if cause != nil {
				return cause
			}
			if c.proc != nil && !c.proc.Alive() {
				return ErrExited
			}
			return ErrBroken
		default:
		}
	}
	return err
}

// commandSnapshot 返回某个远端会话最近一次广播的指令；切片内容不可变，
// 只能整体替换，调用方不得修改。
func (c *Client) commandSnapshot(id string) ([]Command, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	commands, ok := c.commandsBySession[id]
	return commands, ok
}

// ReplayState 返回重放期间收集的 plan/config。
func (c *Client) ReplayState() ([]PlanEntry, []ConfigOption) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]PlanEntry(nil), c.replayPlan...),
		append([]ConfigOption(nil), c.replayConfig...)
}

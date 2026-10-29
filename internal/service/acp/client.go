package acp

import (
	"context"
	"encoding/json"
	"fmt"
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

	mu              sync.Mutex
	initialized     AgentCapabilities
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
	// 重放期间收到的 plan/commands/config：不产生流式事件，
	// 但仍需持久化到会话元数据（Java 只抑制 SSE）。
	replayPlan     []PlanEntry
	replayCommands []Command
	replayConfig   []ConfigOption
}

var _ acpsdk.Client = (*Client)(nil)

// NewClient 启动 ACP 进程并完成 SDK 连接（但不做 initialize）。
func NewClient(launch Launch, cwd string, handler Handler, perm PermissionFunc) (*Client, error) {
	proc, err := startAgentProcess(launch.Command, launch.Env, cwd)
	if err != nil {
		return nil, err
	}
	client := &Client{proc: proc, handler: handler, perm: perm, children: map[string]bool{}}
	client.conn = acpsdk.NewClientSideConnection(client, proc.stdin, proc.stdout)
	return client, nil
}

// SetElicitationHandler 注册 Agent 反向提问处理器。
func (c *Client) SetElicitationHandler(fn ElicitationFunc) {
	c.mu.Lock()
	c.elicit = fn
	c.mu.Unlock()
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
	raw, err := c.conn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd: cwd, McpServers: servers, AdditionalDirectories: dirs,
	})
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
	raw, err := c.conn.LoadSession(ctx, acpsdk.LoadSessionRequest{
		SessionId: acpsdk.SessionId(sessionID), Cwd: cwd, McpServers: servers, AdditionalDirectories: dirs,
	})
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

// ResumeSession 恢复会话但不重放历史（DSH 等仅支持 resume 的 Agent）。
func (c *Client) ResumeSession(ctx context.Context, sessionID, cwd string, dirs []string) (SessionSetupResult, error) {
	c.setReplaying(true)
	defer c.setReplaying(false)
	servers, err := sdkMCP(c.McpPayload())
	if err != nil {
		return SessionSetupResult{}, err
	}
	raw, err := c.conn.ResumeSession(ctx, acpsdk.ResumeSessionRequest{
		SessionId: acpsdk.SessionId(sessionID), Cwd: cwd, McpServers: servers, AdditionalDirectories: dirs,
	})
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
	raw, err := c.conn.UnstableForkSession(ctx, acpsdk.UnstableForkSessionRequest{
		SessionId: acpsdk.SessionId(sourceID), Cwd: cwd, AdditionalDirectories: dirs, Meta: meta,
		McpServers: unstableMCP(servers),
	})
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
	defer c.mu.Unlock()
	if len(result.ConfigOptions) > 0 {
		c.configOptions = result.ConfigOptions
		c.configSupported = true
		return
	}
	c.configOptions = legacyConfigOptions(result.Modes, result.Models)
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
func (c *Client) Alive() bool { return c != nil && c.proc.Alive() }

func (c *Client) fail(err error) error {
	if err == nil {
		return nil
	}
	if c.conn != nil {
		select {
		case <-c.conn.Done():
			if c.proc != nil && !c.proc.Alive() {
				return ErrExited
			}
			return ErrBroken
		default:
		}
	}
	return err
}

// ReplayState 返回重放期间收集的 plan/commands/config。
func (c *Client) ReplayState() ([]PlanEntry, []Command, []ConfigOption) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]PlanEntry(nil), c.replayPlan...),
		append([]Command(nil), c.replayCommands...),
		append([]ConfigOption(nil), c.replayConfig...)
}

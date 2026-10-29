package acp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

const reqPlaceholder = "(plan execution)"

// EventSink 接收一轮外部 Agent 要推给前端的事件。
type EventSink interface {
	Send(event string, payload any)
	SendText(event, text string)
	SendRaw(event string, data []byte)
	SendError(message string)
	Done()
}

// SessionHost 是一轮 ACP 对话需要的工作区能力。
// 聊天接口实现它，把会话元数据、转录和审批交进来。
type SessionHost interface {
	App() string
	Workspace() string
	LinkedDirs() []string
	Meta(session string) map[string]any
	SetMeta(session string, kv map[string]any)
	AppendTranscript(session string, lines []map[string]any) error
	SubSessionsDir(session string) string
	MCPServers(agentID string) []any
	Permissions() *hitl.Registry
	Elicitations() *hitl.ElicitationRegistry
	EnsureTitle(ctx context.Context, session, message string)
}

// TurnInput 是交给外部 Agent 的一轮用户输入。
type TurnInput struct {
	Session string
	AgentID string
	Message string
	Images  []string
}

// Manager 持有每个 Loopra 会话对应的外部 ACP 进程与客户端，
// 使同一会话的连续轮次复用同一个 Agent 会话。
type Manager struct {
	mu    sync.Mutex
	conns map[string]*Conn
}

func NewManager() *Manager {
	return &Manager{conns: map[string]*Conn{}}
}

// Conn 是一个 Loopra 会话绑定的 ACP 连接。
type Conn struct {
	mu      sync.Mutex
	agentID string
	cwd     string
	client  *Client
	turn    *acpTurn
	running bool
	state   *acpSharedState
}

// Client 返回底层协议客户端。
func (c *Conn) Client() *Client { return c.client }

// Dir 返回该连接的工作目录。
func (c *Conn) Dir() string { return c.cwd }

func (m *Manager) key(host SessionHost, name string) string {
	app := "default"
	if host != nil && host.App() != "" {
		app = host.App()
	}
	return app + "::" + name
}

func (m *Manager) get(name string) *Conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conns[name]
}

func (m *Manager) put(name string, conn *Conn) {
	m.mu.Lock()
	previous := m.conns[name]
	m.conns[name] = conn
	m.mu.Unlock()
	if previous != nil && previous != conn {
		previous.close()
	}
}

// Drop 关闭并移除某会话的 ACP 连接。key 是工作区限定后的会话键。
func (m *Manager) Drop(key string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	conn := m.conns[key]
	delete(m.conns, key)
	m.mu.Unlock()
	if conn != nil {
		conn.close()
	}
}

// CloseAll 关闭全部外部 Agent 进程。
func (m *Manager) CloseAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	conns := m.conns
	m.conns = map[string]*Conn{}
	m.mu.Unlock()
	for _, conn := range conns {
		conn.close()
	}
}

func (c *Conn) close() {
	c.mu.Lock()
	client := c.client
	turn := c.turn
	c.client = nil
	c.turn = nil
	c.mu.Unlock()
	if turn != nil {
		turn.endActiveSubAgents("aborted")
		if turn.host != nil {
			turn.host.Elicitations().Cancel(turn.session)
		}
	}
	if client != nil {
		_ = client.Close()
	}
}

func (c *Conn) bindTurn(turn *acpTurn) {
	c.mu.Lock()
	c.turn = turn
	c.running = turn != nil
	c.mu.Unlock()
}

func (c *Conn) currentTurn() *acpTurn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.turn
}

func (c *Conn) handleEvent(event Event) {
	if turn := c.currentTurn(); turn != nil {
		turn.handle(event)
	}
}

func (c *Conn) requestPermission(_ context.Context, request PermissionRequest) (string, bool) {
	turn := c.currentTurn()
	if turn == nil {
		return "", false
	}
	return turn.permission(request)
}

func (c *Conn) requestElicitation(ctx context.Context, request ElicitationRequest) ElicitationResult {
	turn := c.currentTurn()
	if turn == nil {
		return ElicitationResult{Action: "cancel"}
	}
	return turn.elicit(ctx, request)
}

// Cancel 请求某会话的 ACP Agent 取消当前回合。
func (m *Manager) Cancel(host SessionHost, name string) {
	if m == nil {
		return
	}
	conn := m.get(m.key(host, name))
	if conn == nil {
		return
	}
	conn.mu.Lock()
	client := conn.client
	conn.mu.Unlock()
	if turn := conn.currentTurn(); turn != nil {
		turn.endActiveSubAgents("aborted")
		if turn.host != nil {
			turn.host.Elicitations().Cancel(turn.session)
		}
	}
	if client != nil {
		_ = client.Cancel(context.Background())
	}
}

// Acquire 返回可用于该会话的连接，必要时启动进程。
func (m *Manager) Acquire(ctx context.Context, host SessionHost, name, agentID, version string) (*Conn, error) {
	if !IsExternal(agentID) {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	if strings.TrimSpace(name) == "" {
		name = "default"
	}
	key := m.key(host, name)
	if conn := m.get(key); conn != nil {
		conn.mu.Lock()
		usable := conn.agentID == agentID && conn.client != nil && conn.client.Alive()
		conn.mu.Unlock()
		if usable {
			return conn, nil
		}
		m.Drop(key)
	}
	provider, ok := Lookup(agentID)
	if !ok {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	launch, err := provider.Prepare(host.Workspace())
	if err != nil {
		return nil, err
	}
	conn := &Conn{agentID: agentID, cwd: host.Workspace(), state: newACPSharedState()}
	client, err := NewClient(launch, conn.cwd, conn.handleEvent, conn.requestPermission)
	if err != nil {
		return nil, err
	}
	client.SetElicitationHandler(conn.requestElicitation)
	if agentID == "codex" {
		client.EnableChildSessions(true)
	}
	if err := client.Initialize(ctx, version); err != nil {
		_ = client.Close()
		return nil, err
	}
	client.SetMcpServers(client.SupportedMCP(host.MCPServers(agentID)))
	conn.client = client
	m.put(key, conn)
	return conn, nil
}

// OpenSession 建立或恢复 Agent 会话，并持久化绑定信息。
func (m *Manager) OpenSession(ctx context.Context, host SessionHost, name string, conn *Conn, replayHistory bool) ([]ConfigOption, error) {
	if conn.client.SessionID() != "" {
		return conn.client.ConfigOptions(), nil
	}
	meta := host.Meta(name)
	remote := strOr(meta, "acpSessionId", "")
	dirs := host.LinkedDirs()
	capabilities := conn.client.Capabilities()
	canLoad := capabilities.LoadSession
	resume := (!replayHistory || !canLoad) && resumeSupported(capabilities)
	var result SessionSetupResult
	var err error
	switch {
	case remote == "":
		result, err = conn.client.NewSession(ctx, conn.cwd, dirs)
	case resume:
		result, err = conn.client.ResumeSession(ctx, remote, conn.cwd, dirs)
	case canLoad:
		result, err = conn.client.LoadSession(ctx, remote, conn.cwd, dirs)
	default:
		return nil, errors.New("Agent 不支持恢复会话，请创建新会话")
	}
	if err != nil {
		return nil, err
	}
	if result.SessionID == "" {
		return nil, errors.New("Agent returned an empty session ID")
	}
	patch := map[string]any{"agentId": conn.agentID, "acpSessionId": result.SessionID, "acpCwd": conn.cwd}
	if len(result.ConfigOptions) > 0 {
		patch["agentConfig"] = configValues(result.ConfigOptions)
	}
	if plan, commands, _ := conn.client.ReplayState(); len(plan) > 0 || len(commands) > 0 {
		if len(plan) > 0 {
			patch["acpPlan"] = plan
		}
		if payload := commandPayload(commands); len(payload) > 0 {
			patch["acpCommands"] = payload
		}
	}
	host.SetMeta(name, patch)
	restoreAgentConfig(ctx, host, name, conn, result.ConfigOptions)
	return result.ConfigOptions, nil
}

func restoreAgentConfig(ctx context.Context, host SessionHost, name string, conn *Conn, options []ConfigOption) {
	saved := host.Meta(name)["agentConfig"]
	values, ok := saved.(map[string]any)
	if !ok || len(values) == 0 {
		return
	}
	accepted := map[string]string{}
	for _, option := range options {
		if option.ID == "" {
			continue
		}
		value, exists := values[option.ID]
		if !exists || fmt.Sprint(option.CurrentValue) == fmt.Sprint(value) {
			continue
		}
		if updated, err := conn.client.SetConfigOption(ctx, option.ID, value); err == nil {
			accepted[option.ID] = fmt.Sprint(value)
			options = updated
		}
	}
	if len(accepted) == 0 {
		return
	}
	merged := map[string]any{}
	for key, value := range values {
		merged[key] = value
	}
	for key, value := range accepted {
		merged[key] = value
	}
	host.SetMeta(name, map[string]any{"agentConfig": merged})
}

func resumeSupported(capabilities AgentCapabilities) bool {
	if capabilities.SessionCapabilities == nil {
		return false
	}
	_, ok := capabilities.SessionCapabilities["resume"]
	return ok
}

// ConfigValues 把 ACP 配置项压成 .meta 的 agentConfig 映射。
func ConfigValues(options []ConfigOption) map[string]string {
	return configValues(options)
}

func configValues(options []ConfigOption) map[string]string {
	values := map[string]string{}
	for _, option := range options {
		if option.ID == "" {
			continue
		}
		values[option.ID] = fmt.Sprint(option.CurrentValue)
	}
	return values
}

// RunTurn 驱动一次外部 Agent 轮次，并把更新交给 sink。
func (m *Manager) RunTurn(ctx context.Context, host SessionHost, sink EventSink, in TurnInput, msgID string, hasSnapshot bool, version string) {
	name := in.Session
	if strings.TrimSpace(name) == "" {
		name = "default"
	}
	meta := host.Meta(name)
	agentID := in.AgentID
	if agentID == "" {
		agentID = strOr(meta, "agentId", "native")
	}
	if agentID == "native" {
		sink.SendError("Agent 引擎不可用: native")
		return
	}
	started := time.Now()
	logging.Infof("chat", "turn start session=%s agent=%s chars=%d", name, agentID, len([]rune(in.Message)))
	conn, err := m.Acquire(ctx, host, name, agentID, version)
	if err != nil {
		sink.SendError(err.Error())
		return
	}
	if _, err := m.OpenSession(ctx, host, name, conn, true); err != nil {
		sink.SendError(TranslateFailure(err).Error())
		return
	}
	host.EnsureTitle(ctx, name, in.Message)
	turn := &acpTurn{
		host: host, sink: sink, session: name, agentID: agentID, cwd: conn.cwd, runCtx: ctx,
		msgID: msgID, startedAt: time.Now().UnixMilli(), tools: map[string]*acpTool{},
		state: conn.state, subRec: newACPSubAgentRecorder(host.SubSessionsDir(name)),
	}
	turn.appendUser(in.Message, in.Images, hasSnapshot)
	conn.bindTurn(turn)
	defer conn.bindTurn(nil)

	blocks := promptBlocks(in.Message, in.Images)
	result, promptErr := conn.client.Prompt(ctx, blocks)
	turn.finish()
	elapsed := time.Since(started).Round(time.Millisecond)
	if promptErr != nil {
		if ctx.Err() != nil {
			turn.endActiveSubAgents("aborted")
			_ = conn.client.Cancel(context.Background())
			logging.Infof("chat", "turn cancelled session=%s agent=%s in %s", name, agentID, elapsed)
			sink.Send("complete", map[string]any{"stopReason": "cancelled", "status": "cancelled"})
			sink.Done()
			return
		}
		sink.SendError(TranslateFailure(promptErr).Error())
		return
	}
	status, notice := acpStopStatus(result.StopReason)
	if notice != "" {
		logging.Infof("chat", "turn limited session=%s agent=%s reason=%s", name, agentID, result.StopReason)
		sink.Send("log", map[string]any{"level": "WARN", "message": notice})
	}
	content, reasoning, tools := turn.counters()
	logging.Infof("chat", "turn done session=%s agent=%s reason=%s status=%s in %s (content=%d, reasoning=%dB, tools=%d)",
		name, agentID, result.StopReason, status, elapsed, content, reasoning, tools)
	sink.Send("complete", map[string]any{"stopReason": strings.ToLower(result.StopReason), "status": status})
	sink.Done()
}

// TranslateFailure 把底层错误映射成前端可展示的消息。
func TranslateFailure(err error) error { return translateACPFailure(err) }

func strOr(meta map[string]any, key, def string) string {
	if meta == nil {
		return def
	}
	if value, ok := meta[key].(string); ok && value != "" {
		return value
	}
	return def
}

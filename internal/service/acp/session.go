package acp

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
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

// Manager 持有外部 ACP 进程。同一应用、同一 Agent、同一工作目录
// 共用一个空闲进程；每个 Loopra 会话仍有自己的 ACP session。
// 进程正在回复时，新的会话另起进程，避免两路对话交错。
type Manager struct {
	mu       sync.Mutex
	conns    map[string]*Conn
	runtimes map[string]*acpRuntime
	starting map[string]*runtimeStart
}

// acpRuntime 是一个可复用的 ACP 进程。refs 是仍指向它的 Loopra 会话数。
type acpRuntime struct {
	client *Client
	refs   int
	setup  sync.Mutex
}

// runtimeStart 让并发的第一次启动只拉起一个进程。
type runtimeStart struct {
	done   chan struct{}
	client *Client
	err    error
}

func NewManager() *Manager {
	return &Manager{
		conns:    map[string]*Conn{},
		runtimes: map[string]*acpRuntime{},
		starting: map[string]*runtimeStart{},
	}
}

// Conn 是一个 Loopra 会话绑定的 ACP 连接。
// 多个 Conn 可以指向同一个 Client（同一个操作系统进程）。
type Conn struct {
	mu         sync.Mutex
	name       string
	agentID    string
	cwd        string
	client     *Client
	runtimeKey string
	setup      *sync.Mutex
	setupHeld  bool
	// acpSession / options 属于这个 Loopra 会话，不跟进程上最后一次操作走。
	acpSession string
	options    []ConfigOption
	live       bool
	turn       *acpTurn
	running    bool
	busy       bool
	state      *acpSharedState
}

// Client 返回底层协议客户端。
func (c *Conn) Client() *Client { return c.client }

// Dir 返回该连接的工作目录。
func (c *Conn) Dir() string { return c.cwd }

// SessionID 返回这个 Loopra 会话自己的 ACP session id。
func (c *Conn) SessionID() string {
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.acpSession
}

// ConfigOptions 返回这个 Loopra 会话自己的配置项。
func (c *Conn) ConfigOptions() []ConfigOption {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ConfigOption(nil), c.options...)
}

// BindSession 记下该 Loopra 会话的 ACP session 与配置。
func (c *Conn) BindSession(id string, options []ConfigOption) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if id != "" {
		c.acpSession = id
		c.live = true
	}
	if options != nil {
		c.options = append([]ConfigOption(nil), options...)
	}
}

// Use 把共用进程上的后续调用切到这个 Loopra 会话。
func (c *Conn) Use() {
	if c == nil || c.client == nil {
		return
	}
	c.mu.Lock()
	client := c.client
	id := c.acpSession
	c.mu.Unlock()
	client.focus(c, id)
}

// PrepareSetup 在 fork 等会话建立期间独占进程，并接收其更新。
func (c *Conn) PrepareSetup() {
	if c == nil || c.client == nil {
		return
	}
	if c.setup != nil && !c.setupHeld {
		c.setup.Lock()
		c.setupHeld = true
	}
	c.client.beginAccept(c)
}

// FinishSetup 结束 PrepareSetup 持有的进程锁。空 id 不会清掉已绑定的会话。
func (c *Conn) FinishSetup(id string, options []ConfigOption) {
	if c == nil {
		return
	}
	if id != "" || options != nil {
		c.BindSession(id, options)
	}
	if c.client != nil {
		c.client.endAccept(c.SessionID())
	}
	if c.setupHeld && c.setup != nil {
		c.setupHeld = false
		c.setup.Unlock()
	}
}

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
	if m.conns == nil {
		m.conns = map[string]*Conn{}
	}
	previous := m.conns[name]
	m.conns[name] = conn
	m.mu.Unlock()
	if previous != nil && previous != conn {
		m.release(previous)
	}
}

// Drop 移除某会话对 ACP 进程的引用。最后一个引用离开时才关闭进程。
func (m *Manager) Drop(key string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	conn := m.conns[key]
	delete(m.conns, key)
	m.mu.Unlock()
	if conn != nil {
		m.release(conn)
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
	m.runtimes = map[string]*acpRuntime{}
	m.mu.Unlock()
	seen := map[*Client]struct{}{}
	for _, conn := range conns {
		conn.mu.Lock()
		client := conn.client
		turn := conn.turn
		conn.client = nil
		conn.turn = nil
		conn.live = false
		conn.mu.Unlock()
		abortTurn(turn)
		if client != nil {
			client.clearOwner(conn)
			seen[client] = struct{}{}
		}
	}
	for client := range seen {
		_ = client.Close()
	}
}

func (m *Manager) release(conn *Conn) {
	if conn == nil {
		return
	}
	conn.mu.Lock()
	client := conn.client
	turn := conn.turn
	key := conn.runtimeKey
	conn.client = nil
	conn.turn = nil
	conn.live = false
	conn.mu.Unlock()
	abortTurn(turn)
	if client != nil {
		client.clearOwner(conn)
	}
	m.decref(key, client)
}

func abortTurn(turn *acpTurn) {
	if turn == nil {
		return
	}
	turn.endActiveSubAgents("aborted")
	if turn.host != nil {
		turn.host.Elicitations().Cancel(turn.session)
	}
}

func (m *Manager) decref(rtKey string, client *Client) {
	if client == nil {
		return
	}
	m.mu.Lock()
	rt := m.runtimes[rtKey]
	closeClient := true
	if rt != nil && rt.client == client {
		rt.refs--
		if rt.refs > 0 {
			closeClient = false
		} else {
			delete(m.runtimes, rtKey)
		}
	}
	m.mu.Unlock()
	if closeClient {
		_ = client.Close()
	}
}

func (c *Conn) bindTurn(turn *acpTurn) {
	c.mu.Lock()
	c.turn = turn
	c.running = turn != nil
	c.mu.Unlock()
}

func (c *Conn) setBusy(busy bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.busy = busy
	c.mu.Unlock()
}

func (c *Conn) currentTurn() *acpTurn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.turn
}

func (c *Conn) handleEvent(event Event) {
	if event.Kind == EventConfig && len(event.ConfigOptions) > 0 {
		c.BindSession(c.SessionID(), event.ConfigOptions)
	}
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
	conn.Use()
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

// Acquire 返回可用于该会话的连接。空闲时复用同一工作区已有的进程，
// 进程正忙时才另起一个。
func (m *Manager) Acquire(ctx context.Context, host SessionHost, name, agentID, version string) (*Conn, error) {
	if !IsExternal(agentID) {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	if strings.TrimSpace(name) == "" {
		name = "default"
	}
	key := m.key(host, name)
	cwd := ""
	if host != nil {
		cwd = host.Workspace()
	}
	if conn := m.get(key); conn != nil {
		conn.mu.Lock()
		usable := conn.agentID == agentID && filepath.Clean(conn.cwd) == filepath.Clean(cwd) &&
			conn.client != nil && conn.client.Alive()
		conn.mu.Unlock()
		if usable {
			if m.blockedByOther(conn) {
				m.detachClient(conn)
				return m.startPrivate(ctx, host, key, name, agentID, version)
			}
			conn.Use()
			return conn, nil
		}
		m.Drop(key)
	}
	return m.startShared(ctx, host, key, name, agentID, version)
}

// IdleSessions 返回已经建立 ACP 会话、且当前没有在回复的 Loopra 会话名。
func (m *Manager) IdleSessions(host SessionHost, agentID, cwd string) []string {
	if m == nil {
		return nil
	}
	want := filepath.Clean(cwd)
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0)
	for key, conn := range m.conns {
		conn.mu.Lock()
		ok := conn.agentID == agentID && filepath.Clean(conn.cwd) == want &&
			conn.acpSession != "" && conn.live && !conn.running && !conn.busy &&
			conn.client != nil && conn.client.Alive()
		name := conn.name
		conn.mu.Unlock()
		if !ok {
			continue
		}
		if name == "" {
			name = nameFromKey(key)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (m *Manager) startShared(ctx context.Context, host SessionHost, key, name, agentID, version string) (*Conn, error) {
	rtKey := runtimeKey(host, agentID)
	if client := m.takeIdle(rtKey); client != nil {
		logging.Debugf("acp", "reuse process agent=%s session=%s", agentID, name)
		return m.attach(key, name, agentID, host.Workspace(), rtKey, client), nil
	}
	if m.runtimeBusy(rtKey) {
		logging.Debugf("acp", "process busy agent=%s session=%s", agentID, name)
		return m.startPrivate(ctx, host, key, name, agentID, version)
	}
	return m.start(ctx, host, key, name, agentID, version, rtKey)
}

func (m *Manager) startPrivate(ctx context.Context, host SessionHost, key, name, agentID, version string) (*Conn, error) {
	return m.start(ctx, host, key, name, agentID, version, privateRuntimeKey(runtimeKey(host, agentID), name))
}

func (m *Manager) start(ctx context.Context, host SessionHost, key, name, agentID, version, rtKey string) (*Conn, error) {
	m.mu.Lock()
	if m.starting == nil {
		m.starting = map[string]*runtimeStart{}
	}
	if start, ok := m.starting[rtKey]; ok {
		m.mu.Unlock()
		select {
		case <-start.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if start.err != nil {
			return nil, start.err
		}
		m.adopt(rtKey, start.client)
		logging.Debugf("acp", "reuse process agent=%s session=%s", agentID, name)
		return m.attach(key, name, agentID, host.Workspace(), rtKey, start.client), nil
	}
	start := &runtimeStart{done: make(chan struct{})}
	m.starting[rtKey] = start
	m.mu.Unlock()

	client, err := m.launchClient(ctx, host, agentID, version, host.Workspace())
	m.mu.Lock()
	delete(m.starting, rtKey)
	start.client = client
	start.err = err
	close(start.done)
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	m.adopt(rtKey, client)
	return m.attach(key, name, agentID, host.Workspace(), rtKey, client), nil
}

func (m *Manager) launchClient(ctx context.Context, host SessionHost, agentID, version, cwd string) (*Client, error) {
	provider, ok := Lookup(agentID)
	if !ok {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	launch, err := provider.Prepare(cwd)
	if err != nil {
		return nil, err
	}
	// 事件和权限按当前 owner 转发，不绑死在第一个会话上。
	client, err := NewClient(launch, cwd, nil, nil)
	if err != nil {
		return nil, err
	}
	if agentID == "codex" {
		client.EnableChildSessions(true)
	}
	if err := client.Initialize(ctx, version); err != nil {
		_ = client.Close()
		return nil, err
	}
	client.SetMcpServers(client.SupportedMCP(host.MCPServers(agentID)))
	return client, nil
}

func (m *Manager) attach(key, name, agentID, cwd, rtKey string, client *Client) *Conn {
	var setup *sync.Mutex
	m.mu.Lock()
	if rt := m.runtimes[rtKey]; rt != nil && rt.client == client {
		setup = &rt.setup
	}
	m.mu.Unlock()
	conn := &Conn{
		name: name, agentID: agentID, cwd: cwd, client: client,
		runtimeKey: rtKey, setup: setup, state: newACPSharedState(),
	}
	m.put(key, conn)
	conn.Use()
	return conn
}

func (m *Manager) adopt(rtKey string, client *Client) {
	if client == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtimes == nil {
		m.runtimes = map[string]*acpRuntime{}
	}
	if rt := m.runtimes[rtKey]; rt != nil && rt.client == client {
		rt.refs++
		return
	}
	m.runtimes[rtKey] = &acpRuntime{client: client, refs: 1}
}

func (m *Manager) takeIdle(rtKey string) *Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.runtimes[rtKey]
	if rt == nil || rt.client == nil || !rt.client.Alive() {
		if rt != nil {
			delete(m.runtimes, rtKey)
		}
		return nil
	}
	if m.clientBusy(rt.client) {
		return nil
	}
	rt.refs++
	return rt.client
}

func (m *Manager) runtimeBusy(rtKey string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.runtimes[rtKey]
	if rt == nil || rt.client == nil || !rt.client.Alive() {
		return false
	}
	return m.clientBusy(rt.client)
}

func (m *Manager) blockedByOther(self *Conn) bool {
	if self == nil {
		return false
	}
	self.mu.Lock()
	client := self.client
	self.mu.Unlock()
	if client == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, conn := range m.conns {
		if conn == self {
			continue
		}
		conn.mu.Lock()
		hit := conn.client == client && (conn.running || conn.busy)
		conn.mu.Unlock()
		if hit {
			return true
		}
	}
	return false
}

// clientBusy 必须在持有 m.mu 时调用。
func (m *Manager) clientBusy(client *Client) bool {
	for _, conn := range m.conns {
		conn.mu.Lock()
		hit := conn.client == client && (conn.running || conn.busy)
		conn.mu.Unlock()
		if hit {
			return true
		}
	}
	return false
}

func (m *Manager) detachClient(conn *Conn) {
	if conn == nil {
		return
	}
	conn.mu.Lock()
	client := conn.client
	key := conn.runtimeKey
	conn.client = nil
	conn.live = false
	conn.mu.Unlock()
	if client != nil {
		client.clearOwner(conn)
	}
	m.decref(key, client)
}

func runtimeKey(host SessionHost, agentID string) string {
	app := "default"
	if host != nil && host.App() != "" {
		app = host.App()
	}
	cwd := ""
	if host != nil {
		cwd = filepath.Clean(host.Workspace())
	}
	return app + "\x00" + agentID + "\x00" + cwd
}

func privateRuntimeKey(shared, name string) string {
	return shared + "\x00" + name
}

func nameFromKey(key string) string {
	if _, name, ok := strings.Cut(key, "::"); ok {
		return name
	}
	return key
}

// OpenSession 建立或恢复 Agent 会话，并持久化绑定信息。
// 已经在这个进程上建立过的会话直接返回自己的配置，不再看进程上最后一次的 session id。
func (m *Manager) OpenSession(ctx context.Context, host SessionHost, name string, conn *Conn, replayHistory bool) ([]ConfigOption, error) {
	if conn == nil || conn.client == nil {
		return nil, errors.New("Agent 会话正在初始化")
	}
	if conn.setup != nil {
		conn.setup.Lock()
		defer conn.setup.Unlock()
	}
	conn.mu.Lock()
	live := conn.live
	cached := append([]ConfigOption(nil), conn.options...)
	conn.mu.Unlock()
	if live {
		conn.Use()
		return cached, nil
	}
	conn.client.beginAccept(conn)
	defer func() { conn.client.endAccept(conn.SessionID()) }()
	meta := host.Meta(name)
	remote := strOr(meta, "acpSessionId", "")
	if remote == "" {
		remote = conn.SessionID()
	}
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
	conn.BindSession(result.SessionID, conn.client.ConfigOptions())
	return conn.ConfigOptions(), nil
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
	conn.setBusy(true)
	defer conn.setBusy(false)
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

	conn.Use()
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

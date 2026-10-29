// Package acpserver 用 coder/acp-go-sdk 把 Loopra 原生智能体暴露成 ACP Agent。
// 外部编辑器通过 stdio 调用 `loopra acp`。工作台内部会话走 Loopra Native，不拉起这条命令。
package acpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	modelconfig "github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// 与 HTTP 服务公布的版本保持一致。
const version = "0.1.0-go"

// Runtime 是一个 ACP Agent 进程里的 Loopra 运行时。
type Runtime struct {
	home     string
	cfg      *modelconfig.Loopra
	model    model.LLM
	sessions *jsonl.Service

	mu    sync.Mutex
	conn  *acpsdk.AgentSideConnection
	lives map[string]*liveSession
}

type liveSession struct {
	mu          sync.Mutex
	id          string
	cwd         string
	dirs        []string
	mode        string
	model       string
	channel     string
	effort      string
	fast        bool
	plan        bool
	instruction string
	cfg         *modelconfig.Loopra
	registry    *tools.Registry
	servers     []acpsdk.McpServer
	mcp         tool.Toolset
	agent       *agentpkg.Agent
	stale       bool
}

// Open 按进程配置读取业务配置，准备 ACP 运行时。
func Open(_ context.Context, settings *config.Server) (*Runtime, error) {
	repo := repository.NewConfigRepository(settings.Home)
	cfg, err := repo.Load()
	if err != nil {
		return nil, err
	}
	logging.Infof("acp", "home=%s model=%s channel=%s", settings.Home, cfg.Model, cfg.ModelChannelID)
	return New(settings.Home, cfg), nil
}

// New 用已经载入的配置构造运行时。model 为空时按配置里的通道创建。
func New(home string, cfg *modelconfig.Loopra) *Runtime {
	if cfg == nil {
		fallback := modelconfig.Default()
		cfg = &fallback
	}
	return &Runtime{
		home: home, cfg: cfg, sessions: jsonl.NewService(home), lives: map[string]*liveSession{},
	}
}

// UseModel 在测试里换成不访问网络的模型。
func (r *Runtime) UseModel(llm model.LLM) {
	r.mu.Lock()
	r.model = llm
	r.mu.Unlock()
}

func (r *Runtime) bind(conn *acpsdk.AgentSideConnection) {
	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()
}

// Serve 在 stdio 上接入 ACP 客户端，直到对端断开或 ctx 结束。
func Serve(ctx context.Context, runtime *Runtime) error {
	return ServeStreams(ctx, runtime, os.Stdout, os.Stdin)
}

// ServeStreams 在给定的读写流上接入 ACP 客户端。
func ServeStreams(ctx context.Context, runtime *Runtime, toClient io.Writer, fromClient io.Reader) error {
	conn := acpsdk.NewAgentSideConnection(runtime, toClient, fromClient)
	conn.SetLogger(logging.LibraryLogger())
	runtime.bind(conn)
	select {
	case <-ctx.Done():
		return nil
	case <-conn.Done():
		return nil
	}
}

func (r *Runtime) Initialize(context.Context, acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	return acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		AgentInfo:       &acpsdk.Implementation{Name: "looprax", Version: version, Title: acpsdk.Ptr("LoopraX")},
		AgentCapabilities: acpsdk.AgentCapabilities{
			LoadSession: true,
			PromptCapabilities: acpsdk.PromptCapabilities{
				Image: true, EmbeddedContext: true,
			},
			McpCapabilities: acpsdk.McpCapabilities{Http: true, Sse: true},
			SessionCapabilities: acpsdk.SessionCapabilities{
				Resume: &acpsdk.SessionResumeCapabilities{},
				Fork:   &acpsdk.SessionForkCapabilities{},
			},
			Meta: map[string]any{"loopra.dev/workbench": true},
		},
	}, nil
}

func (r *Runtime) Authenticate(context.Context, acpsdk.AuthenticateRequest) (acpsdk.AuthenticateResponse, error) {
	return acpsdk.AuthenticateResponse{}, nil
}

func (r *Runtime) Logout(context.Context, acpsdk.LogoutRequest) (acpsdk.LogoutResponse, error) {
	return acpsdk.LogoutResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodLogout)
}

func (r *Runtime) Cancel(context.Context, acpsdk.CancelNotification) error { return nil }

func (r *Runtime) CloseSession(context.Context, acpsdk.CloseSessionRequest) (acpsdk.CloseSessionResponse, error) {
	return acpsdk.CloseSessionResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionClose)
}

func (r *Runtime) ListSessions(context.Context, acpsdk.ListSessionsRequest) (acpsdk.ListSessionsResponse, error) {
	return acpsdk.ListSessionsResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionList)
}

func (r *Runtime) NewSession(_ context.Context, params acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	live, err := r.open(newID(), params.Cwd, params.AdditionalDirectories)
	if err != nil {
		return acpsdk.NewSessionResponse{}, err
	}
	live.servers = append([]acpsdk.McpServer(nil), params.McpServers...)
	return acpsdk.NewSessionResponse{
		SessionId: acpsdk.SessionId(live.id), ConfigOptions: live.options(), Modes: live.modes(),
	}, nil
}

func (r *Runtime) LoadSession(ctx context.Context, params acpsdk.LoadSessionRequest) (acpsdk.LoadSessionResponse, error) {
	live, err := r.open(string(params.SessionId), params.Cwd, params.AdditionalDirectories)
	if err != nil {
		return acpsdk.LoadSessionResponse{}, err
	}
	live.servers = append([]acpsdk.McpServer(nil), params.McpServers...)
	if err := live.ensure(r); err != nil {
		return acpsdk.LoadSessionResponse{}, err
	}
	if err := live.mustExist(ctx); err != nil {
		return acpsdk.LoadSessionResponse{}, err
	}
	return acpsdk.LoadSessionResponse{ConfigOptions: live.options(), Modes: live.modes()}, nil
}

func (r *Runtime) ResumeSession(ctx context.Context, params acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	live, err := r.open(string(params.SessionId), params.Cwd, params.AdditionalDirectories)
	if err != nil {
		return acpsdk.ResumeSessionResponse{}, err
	}
	live.servers = append([]acpsdk.McpServer(nil), params.McpServers...)
	if err := live.ensure(r); err != nil {
		return acpsdk.ResumeSessionResponse{}, err
	}
	if err := live.mustExist(ctx); err != nil {
		return acpsdk.ResumeSessionResponse{}, err
	}
	return acpsdk.ResumeSessionResponse{ConfigOptions: live.options(), Modes: live.modes()}, nil
}

func (r *Runtime) SetSessionMode(_ context.Context, params acpsdk.SetSessionModeRequest) (acpsdk.SetSessionModeResponse, error) {
	live := r.session(string(params.SessionId))
	if live == nil {
		return acpsdk.SetSessionModeResponse{}, fmt.Errorf("会话不存在")
	}
	live.setMode(string(params.ModeId))
	return acpsdk.SetSessionModeResponse{}, nil
}

func (r *Runtime) SetSessionConfigOption(_ context.Context, params acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	id, value, sessionID := configValue(params)
	live := r.session(sessionID)
	if live == nil {
		return acpsdk.SetSessionConfigOptionResponse{}, fmt.Errorf("会话不存在")
	}
	if err := live.applyOption(r, id, value); err != nil {
		return acpsdk.SetSessionConfigOptionResponse{}, err
	}
	return acpsdk.SetSessionConfigOptionResponse{ConfigOptions: live.options()}, nil
}

func (r *Runtime) Prompt(ctx context.Context, params acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	live := r.session(string(params.SessionId))
	if live == nil {
		return acpsdk.PromptResponse{}, fmt.Errorf("会话不存在")
	}
	if err := live.ensure(r); err != nil {
		return acpsdk.PromptResponse{}, err
	}
	reason, err := live.run(ctx, r, params.Prompt)
	if err != nil {
		return acpsdk.PromptResponse{}, err
	}
	return acpsdk.PromptResponse{StopReason: reason}, nil
}

func (r *Runtime) session(id string) *liveSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lives[id]
}

func (r *Runtime) open(id, cwd string, dirs []string) (*liveSession, error) {
	root, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("工作目录不存在: %s", cwd)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.lives[id]; existing != nil {
		existing.dirs = dirs
		return existing, nil
	}
	if id == "" {
		id = newID()
	}
	cfg := r.cfg.Clone()
	registry := tools.NewRegistry(append(tools.FileTools(root), tools.BashTools(root)...)...)
	registry.Configure(cfg.DisabledTools, cfg.AutoWhitelist, cfg.ToolReadOnlyOverrides)
	live := &liveSession{
		id: id, cwd: root, dirs: dirs,
		mode: hitl.NormalizeMode(cfg.Hitl), model: cfg.Model, channel: cfg.ModelChannelID,
		effort: cfg.ReasoningEffort, fast: cfg.FastMode,
		instruction: instruction(r.home, root), cfg: cfg, registry: registry,
	}
	live.installPolicy(cfg)
	live.installSessionTools(r)
	r.lives[id] = live
	return live, nil
}

func (s *liveSession) installPolicy(cfg *modelconfig.Loopra) {
	whitelist := map[string]bool{}
	for _, name := range cfg.AutoWhitelist {
		whitelist[name] = true
	}
	overrides := cfg.ToolReadOnlyOverrides
	blocked := append([]string(nil), cfg.BlockedPaths...)
	root := s.cwd
	s.registry.SetPolicy(&hitl.Policy{
		Mode: func() string { return cfg.Hitl },
		SessionMode: func(string) string {
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.mode
		},
		Workspace: func() string { return root },
		BlockedPaths: func() []string {
			return blocked
		},
		ReadOnlyOverride: func(name string) *bool {
			if overrides == nil {
				return nil
			}
			value, ok := overrides[name]
			if !ok {
				return nil
			}
			return &value
		},
		AutoApproved: func(name string) bool { return whitelist[name] },
	})
}

func (r *Runtime) allowsModel(value string) bool {
	channelID, name, ok := strings.Cut(value, ":")
	if !ok || channelID == "" || name == "" {
		return false
	}
	channel, found := r.cfg.ChannelByID(channelID)
	if !found {
		return false
	}
	if len(channel.Models) == 0 {
		return channelID == r.cfg.ModelChannelID && name == r.cfg.Model
	}
	for _, item := range channel.Models {
		if item.Name == name {
			return true
		}
	}
	return false
}

func (s *liveSession) mustExist(ctx context.Context) error {
	if s.agent == nil {
		return fmt.Errorf("会话尚未建立")
	}
	_, err := s.agent.Sessions.Get(ctx, &session.GetRequest{
		AppName: s.agent.App(), UserID: s.agent.User(), SessionID: s.id,
	})
	if err != nil {
		return fmt.Errorf("会话不存在")
	}
	return nil
}

func (s *liveSession) ensure(r *Runtime) error {
	if s.agent != nil && !s.stale {
		return nil
	}
	s.mu.Lock()
	modelName, channelID, effort, fast, plan := s.model, s.channel, s.effort, s.fast, s.plan
	s.mu.Unlock()
	cfg := r.cfg.Clone()
	cfg.Model, cfg.ModelChannelID, cfg.ReasoningEffort, cfg.FastMode = modelName, channelID, effort, fast
	sets := []tool.Toolset{s.registry}
	if mcpTools := s.mcpToolset(); mcpTools != nil {
		sets = append(sets, mcpTools)
	}
	opts := agentpkg.Options{
		Toolsets:    sets,
		Config:      cfg,
		Instruction: sessionInstruction(s.instruction, plan),
		Sessions:    r.sessions,
	}
	r.mu.Lock()
	opts.Model = r.model
	r.mu.Unlock()
	built, err := agentpkg.New(r.home, service.WorkspaceHash(s.cwd), cfg, opts)
	if err != nil {
		return err
	}
	s.agent = built
	s.stale = false
	return nil
}

func (s *liveSession) options() []acpsdk.SessionConfigOption {
	s.mu.Lock()
	mode, model, channel, effort, fast, plan := s.mode, s.model, s.channel, s.effort, s.fast, s.plan
	cfg := s.cfg
	s.mu.Unlock()
	return sessionOptions(cfg, mode, channel+":"+model, effort, fast, plan)
}

func (s *liveSession) modes() *acpsdk.SessionModeState {
	s.mu.Lock()
	mode := s.mode
	s.mu.Unlock()
	return &acpsdk.SessionModeState{
		CurrentModeId: acpsdk.SessionModeId(mode),
		AvailableModes: []acpsdk.SessionMode{
			{Id: hitl.ModeApproval, Name: "按需审批"},
			{Id: hitl.ModeAuto, Name: "自动审批"},
			{Id: hitl.ModeFree, Name: "完全自动"},
		},
	}
}

func (s *liveSession) setMode(mode string) {
	s.mu.Lock()
	s.mode = hitl.NormalizeMode(mode)
	s.mu.Unlock()
}

func (s *liveSession) applyOption(r *Runtime, id, value string) error {
	switch id {
	case "model":
		if !r.allowsModel(value) {
			return fmt.Errorf("未知模型 %s", value)
		}
		channel, name, _ := strings.Cut(value, ":")
		s.mu.Lock()
		s.channel, s.model, s.stale = channel, name, true
		s.mu.Unlock()
	case "mode":
		switch hitl.NormalizeMode(value) {
		case hitl.ModeFree, hitl.ModeApproval, hitl.ModeAuto:
		default:
			return fmt.Errorf("无效的权限模式")
		}
		s.setMode(value)
	case "effort":
		switch value {
		case "none", "minimal", "low", "medium", "high", "xhigh", "max":
		default:
			return fmt.Errorf("无效的思考强度")
		}
		s.mu.Lock()
		s.effort, s.stale = value, true
		s.mu.Unlock()
	case "fast", "plan":
		if value != "on" && value != "off" {
			return fmt.Errorf("无效的开关值")
		}
		s.mu.Lock()
		if id == "fast" {
			s.fast, s.stale = value == "on", true
		} else {
			s.plan, s.stale = value == "on", true
		}
		s.mu.Unlock()
	default:
		return fmt.Errorf("不支持的配置 %s", id)
	}
	return nil
}

func configValue(params acpsdk.SetSessionConfigOptionRequest) (id, value, sessionID string) {
	if params.Boolean != nil {
		return string(params.Boolean.ConfigId), fmt.Sprint(params.Boolean.Value), string(params.Boolean.SessionId)
	}
	if params.ValueId != nil {
		return string(params.ValueId.ConfigId), string(params.ValueId.Value), string(params.ValueId.SessionId)
	}
	return "", "", ""
}

func instruction(home, workspace string) string {
	var text strings.Builder
	text.WriteString(agentpkg.DefaultInstruction)
	text.WriteString("\n\n")
	text.WriteString(shellenv.Instruction(workspace))
	for _, path := range []string{
		filepath.Join(home, "loopra.md"),
		filepath.Join(workspace, "loopra.md"),
		filepath.Join(workspace, "AGENTS.md"),
	} {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			text.WriteString("\n\n")
			text.Write(data)
		}
	}
	text.WriteString("\n\n可用技能（先使用 skillread 读取完整规约）：\n")
	for _, entry := range skillMetadata(home, workspace) {
		fmt.Fprintf(&text, "- %s: %s\n", entry["scope"], entry["description"])
	}
	return text.String()
}

func newID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "session"
	}
	return hex.EncodeToString(buf)
}

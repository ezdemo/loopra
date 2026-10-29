// Package agent 在 ADK Go 之上组装 Looprax 智能体运行时：
// 基于 channel 的模型提供商、JSONL 会话服务，以及
// 由 ADK runner 驱动的 llmagent。
package agent

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"net/http"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/plugin"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/provider"
	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/model/config"
)

// DefaultInstruction 是分片 PromptRegistry 落地前的
// 最小系统提示词。
const DefaultInstruction = "You are Loopra, a coding agent working inside the user's project."

// Agent 是绑定到某个工作区（app 名称）的一套组装好的运行时。
type Agent struct {
	Root     agent.Agent
	Runner   *runner.Runner
	Model    model.LLM
	Sessions *jsonl.Service

	cfg         *config.Loopra
	app         string
	user        string
	options     Options
	instruction string
}

// Config 返回该智能体组装时使用的配置。
func (a *Agent) Config() *config.Loopra { return a.cfg }

// Options 用于调整组装。Model 为 nil 时按配置中的通道构建。
type Options struct {
	Model       model.LLM
	Tools       []tool.Tool
	Toolsets    []tool.Toolset
	Config      *config.Loopra
	Instruction string
	HTTPClient  *http.Client
	UserID      string // 默认为 "default"
	Sessions    *jsonl.Service
}

// ToolResultSink 接收单个工具完成时的结果。ADK 会把并行函数调用的
// 结果合并成一个事件后才交给调用方，安装接收端后即可让先完成的
// 工具立即上报（ToolResultSent 用于在合并事件到达时去重）。
type ToolResultSink interface {
	ToolFinished(callID, name string, response map[string]any)
	ToolResultSent(callID string) bool
}

type toolResultSinkKey struct{}

// WithToolResultSink 在请求上下文中安装工具完成接收端。
func WithToolResultSink(ctx context.Context, sink ToolResultSink) context.Context {
	return context.WithValue(ctx, toolResultSinkKey{}, sink)
}

// ToolResultSinkFromContext 返回当前生效的接收端，未安装时为 nil。
func ToolResultSinkFromContext(ctx context.Context) ToolResultSink {
	sink, _ := ctx.Value(toolResultSinkKey{}).(ToolResultSink)
	return sink
}

// ToolResultPlugin 返回工具完成通知插件。主代理与子代理的 runner
// 都安装它，并行调用中的每个工具完成时即可上报结果。
func ToolResultPlugin() (*plugin.Plugin, error) {
	return plugin.New(plugin.Config{Name: "loopra-tool-results", AfterToolCallback: notifyToolResult})
}

// notifyToolResult 是安装到 runner 的 AfterToolCallback：每个工具
// 执行完就立刻通知接收端，而不是等整批并行调用合并完成。
func notifyToolResult(ctx agent.Context, t tool.Tool, _ map[string]any, result map[string]any, err error) (map[string]any, error) {
	sink := ToolResultSinkFromContext(ctx)
	if sink == nil {
		return nil, nil
	}
	// 等待审批的占位结果由聊天层以 choice 事件呈现，不能当成完成上报。
	if errors.Is(err, tool.ErrConfirmationRequired) || errors.Is(err, tool.ErrConfirmationRejected) {
		return nil, nil
	}
	if result == nil {
		if err == nil {
			// 延迟/长任务此时还没有结果，完成时由合并事件上报。
			return nil, nil
		}
		result = map[string]any{"error": err.Error()}
	}
	if id := ctx.FunctionCallID(); id != "" {
		sink.ToolFinished(id, t.Name(), result)
	}
	return nil, nil
}

// New 为 app（Loopra 工作区哈希）标识的工作区组装智能体，
// 并使用 root 下的 Loopra 主目录。
func New(root, app string, cfg *config.Loopra, opts Options) (*Agent, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}
	original := opts
	if opts.Model == nil {
		ch, ok := cfg.ChannelByID(cfg.ModelChannelID)
		if !ok {
			return nil, fmt.Errorf("model channel %q not found", cfg.ModelChannelID)
		}
		llm, err := provider.NewLLM(provider.Channel{
			ID: ch.ID, Name: ch.Name, BaseURL: ch.BaseURL, APIKey: ch.APIKey,
			APIProtocol: ch.APIProtocol, SpecialCompatibility: ch.SpecialCompatibility,
			Models: toProviderModels(ch.Models),
		}, &provider.Options{
			Model:           cfg.Model,
			ReasoningEffort: cfg.ReasoningEffort,
			ServiceTierFast: cfg.FastMode,
			Client:          opts.HTTPClient,
		})
		if err != nil {
			return nil, err
		}
		opts.Model = llm
	}
	instruction := opts.Instruction
	if instruction == "" {
		instruction = DefaultInstruction
	}
	user := opts.UserID
	if user == "" {
		user = "default"
	}
	// 系统提示词已在本包内拼装完成（含工作区 AGENTS.md 等用户文件），
	// 因此用 InstructionProvider 关闭 ADK 的 {} 会话状态占位符替换：
	// 否则用户文件里的 {id} 之类示例会被当成 state 键并报错。
	instructionProvider := func(agent.ReadonlyContext) (string, error) { return instruction, nil }
	rootAgent, err := llmagent.New(llmagent.Config{
		Name:                "loopra",
		Model:               opts.Model,
		Description:         "Loopra coding agent",
		InstructionProvider: instructionProvider,
		Tools:               opts.Tools,
		Toolsets:            opts.Toolsets,
	})
	if err != nil {
		return nil, err
	}
	sessions := opts.Sessions
	if sessions == nil {
		sessions = jsonl.NewService(root)
	}
	// 工具完成通知器对所有经由本包组装的 runner 生效；没有安装
	// ToolResultSink 的调用（静默轮次、离线运行）会直接跳过。
	notifier, err := ToolResultPlugin()
	if err != nil {
		return nil, fmt.Errorf("install tool result notifier: %w", err)
	}
	run, err := runner.New(runner.Config{
		AppName: app, Agent: rootAgent, SessionService: sessions,
		PluginConfig: runner.PluginConfig{Plugins: []*plugin.Plugin{notifier}},
	})
	if err != nil {
		return nil, err
	}
	return &Agent{Root: rootAgent, Runner: run, Model: opts.Model, Sessions: sessions, cfg: cfg, app: app, user: user, options: original, instruction: instruction}, nil
}

func (a *Agent) Instruction() string { return a.instruction }

// Derive 在组装项目或会话专属运行时保留已注入的模型与工具。
// 已有会话仍保存在共享存储中。
func (a *Agent) Derive(app string, cfg *config.Loopra, sets []tool.Toolset, instruction string) (*Agent, error) {
	opts := a.options
	opts.Config = cfg
	opts.Sessions = a.Sessions
	if sets != nil {
		opts.Toolsets = sets
	}
	if instruction != "" {
		opts.Instruction = instruction
	}
	return New(a.Sessions.Root(), app, cfg, opts)
}

func toProviderModels(in []config.ModelEntry) []provider.ModelEntry {
	out := make([]provider.ModelEntry, 0, len(in))
	for _, m := range in {
		out = append(out, provider.ModelEntry{
			Name: m.Name, ContextTokens: m.ContextTokens,
			MaxTokens: m.MaxTokens, ImageInput: m.ImageInput,
		})
	}
	return out
}

// App 返回该智能体绑定的工作区哈希。
func (a *Agent) App() string { return a.app }

// User 返回当前操作用户 ID。
func (a *Agent) User() string { return a.user }

// Session 按名称加载会话，不存在时创建。
func (a *Agent) Session(ctx context.Context, name string) (session.Session, error) {
	if name == "" {
		name = "default"
	}
	got, err := a.Sessions.Get(ctx, &session.GetRequest{AppName: a.app, UserID: a.user, SessionID: name})
	if err == nil {
		return got.Session, nil
	}
	created, err := a.Sessions.Create(ctx, &session.CreateRequest{
		AppName: a.app, UserID: a.user, SessionID: name,
	})
	if err != nil {
		return nil, err
	}
	return created.Session, nil
}

// Run 驱动一个用户轮次，并流式输出 ADK 事件。
func (a *Agent) Run(ctx context.Context, sess session.Session, msg *genai.Content) iter.Seq2[*session.Event, error] {
	return a.Runner.Run(ctx, a.user, sess.ID(), msg, agent.RunConfig{StreamingMode: agent.StreamingModeSSE})
}

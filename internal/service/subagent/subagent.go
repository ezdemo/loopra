// Package subagent 在 ADK 上实现 Loopra 子代理运行时：
// 一个对工具可见的 runner，每次 sub_agent 调用都会启动
// 独立的智能体循环，记录 Loopra 格式的 .sub/{subSessionId}.jsonl
// 事件日志，并将实时的 sub_* 事件转发到父聊天流。
package subagent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/internal/model/config"
	loopraagent "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// Sink 接收实时的 sub_* 事件（父聊天的 SSE 流）。
type Sink interface {
	SendSub(event string, payload map[string]any)
}

// Profile 是一个子代理角色（内置或用户自定义）。
type Profile struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Enable       bool     `json:"enable"`
	ReadOnly     bool     `json:"readOnly"`
	Instructions string   `json:"instructions"`
	AllowedTools []string `json:"allowedTools"`
	ModelChannel string   `json:"modelChannel"`
	Model        string   `json:"model"`
	// StrictModel 表示渠道覆盖是强制要求（Fusion 执行模型）：构建失败
	// 直接报错，不允许静默回退到父模型，也不进入进程级可续聊表。
	StrictModel bool `json:"-"`
}

// DenyTools 是应用于每个子代理的硬性禁止列表（Java
// SubAgent.SUB_AGENT_DENY）：子代理不能派生子代理，也不能
// 操纵 goals/checklists。
var DenyTools = []string{
	"sub_agent", "fusion_delegate", "checklist_start",
	"checklist_step", "checklist_status", "checklist_update", "goal_create", "goal_status",
	"goal_update_step", "goal_complete", "goal_block", "goal_resume", "ask_choice",
}

// Result 承载一次已完成的子代理执行。
type Result struct {
	SubSessionID string
	Title        string
	Reply        string
	Status       string // completed | aborted | error
}

// Runner 启动子代理循环。
type Runner struct {
	// ParentModel 是父智能体使用的模型。
	ParentModel model.LLM
	Config      *config.Loopra
	Workspace   string
	// BuildModel 解析角色的渠道覆盖；reasoningEffort 为空时
	// 不向提供商发送强度参数。
	BuildModel func(channelID, modelName, reasoningEffort string) (model.LLM, error)
	// Profiles 按 id 解析角色定义。
	Profiles func(id string) (Profile, bool)
	// Registry 是用于复制条目的父工具注册表。
	Registry *tools.Registry
	// Environment describes the actual workspace and shell inherited from the parent.
	Environment string
	// SubDir 是某个父会话的 .sub 目录。
	SubDir func(parentSession string) string
	// TimeoutSec 限制单次子运行时长（SubAgentTimeoutSec）。
	TimeoutSec int
	// Gate 在设置时用审批链包装单个工具；session 是
	// 该审批应归属的会话名。
	Gate func(session string, t tool.Tool) tool.Tool
	// Permissions 处理子代理审批（POST /chat/permission 与
	// /chat/sub-hitl/{subId}）；为 nil 时禁用子代理 HITL 暂停。
	Permissions *hitl.Registry
	// FusionScope 是本轮 Fusion 执行上下文的作用域指纹：非空时
	// StrictModel 角色在同名检查点上续用上下文。
	FusionScope string
	// FusionInstruction 是 Fusion 执行代理的常驻系统提示；角色
	// 约定与任务随每次委派消息下发，不进系统提示词。
	FusionInstruction string
	// FusionModelChannel/FusionModel 是 fusion_delegate 固定路由的
	// 执行模型；只在 RunFusion 路径覆盖角色模型，普通 sub_agent
	// 仍按角色自身配置或父模型运行。
	FusionModelChannel string
	FusionModel        string
	// FusionReasoningEffort 是执行模型独立的推理强度，空值
	// 表示跟随模型自身默认；只作用于 fusion_delegate，不影响
	// 主模型或普通 sub_agent 的强度。
	FusionReasoningEffort string
	// fusionMu 串行化同一轮 Runner 上的 Fusion 委派：一次交接
	// 完成前不允许下一次写入同一上下文。
	fusionMu sync.Mutex
}

var subIDCounter atomic.Int64

// NextSubID 分配进程级的 subId（Java AtomicInteger）。
func NextSubID() int { return int(subIDCounter.Add(1)) }

func newSubSessionID() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("sub-%d", time.Now().UnixNano())
	}
	return "sub-" + hex.EncodeToString(buf)
}

// BuildTitle 生成展示标题："name：任务首句"，在首个
// 句子断点处截断并限制在 60 个字符内。
func BuildTitle(name, task string) string {
	first := strings.TrimSpace(task)
	if idx := strings.IndexAny(first, "\n。！？!?"); idx >= 0 {
		first = first[:idx]
	}
	if runes := []rune(first); len(runes) > 60 {
		first = string(runes[:60]) + "…"
	}
	return name + "：" + first
}

// liveRun 跟踪一次已完成的子运行，用于继续对话。
type liveRun struct {
	owner        tools.SessionOwner
	imageConfig  *config.Loopra
	subID        int
	subSessionID string
	title        string
	runner       *runner.Runner
	sess         session.Session
	mu           sync.Mutex
	busy         bool
}

var (
	runsMu    sync.Mutex
	resumable = map[string]*liveRun{} // LRU 上限 20（Java SubAgentSessionManager）
	resumeOrd []string
)

// Run 执行一次子代理轮次：校验、启动独立循环、
// 流式发送 sub_* 事件、记录 .sub 日志并返回最终回复。
func (r *Runner) Run(ctx context.Context, parentSession, name, profileID, task, instructions string, sink Sink) (Result, error) {
	return r.run(ctx, parentSession, name, profileID, task, instructions, sink, false)
}

// RunFusion 是 fusion_delegate 的入口：只接受 explore/implement/test
// 角色，强制使用配置的执行模型与持久上下文，同步等待最终结果。
func (r *Runner) RunFusion(ctx context.Context, parentSession, profileID, task, instructions string, sink Sink) (Result, error) {
	switch profileID {
	case "explore", "implement", "test":
	default:
		return Result{}, fmt.Errorf("Fusion 仅支持 explore、implement 或 test 角色")
	}
	return r.run(ctx, parentSession, "Fusion", profileID, task, instructions, sink, true)
}

func (r *Runner) run(ctx context.Context, parentSession, name, profileID, task, instructions string, sink Sink, fusion bool) (Result, error) {
	profile, ok := r.Profiles(profileID)
	if !ok || !profile.Enable {
		return Result{}, fmt.Errorf("INVALID_SUB_AGENT_PROFILE: %s", profileID)
	}
	if fusion {
		// 委派路径的角色模型来自会话的 Fusion 设置，用户输入不可选。
		profile.ModelChannel, profile.Model = r.FusionModelChannel, r.FusionModel
		profile.StrictModel = true
		if profileID == "explore" {
			profile.ReadOnly = true
		}
	}
	if strings.TrimSpace(name) == "" {
		return Result{}, fmt.Errorf("INVALID_SUB_AGENT_NAME: name 必填")
	}
	if strings.TrimSpace(task) == "" {
		return Result{}, fmt.Errorf("INVALID_SUB_AGENT_TASK: task 必填")
	}
	if profile.StrictModel {
		if r.FusionScope == "" {
			return Result{}, fmt.Errorf("Fusion 执行上下文未配置")
		}
		// 同一上下文同一时刻只允许一次交接；并发的委派调用直接
		// 拒绝，fusion_delegate 同步把失败作为结果返回给主代理。
		if !r.fusionMu.TryLock() {
			return Result{}, fmt.Errorf("Fusion 执行代理正在处理上一项交接，请等待完成后重试")
		}
		defer r.fusionMu.Unlock()
	}

	subID := NextSubID()
	subSessionID := newSubSessionID()
	title := BuildTitle(name, task)

	llm := r.ParentModel
	if profile.StrictModel {
		llm = nil
	}
	selectedChannel := ""
	reasoningEffort := ""
	if fusion {
		reasoningEffort = r.FusionReasoningEffort
	}
	if profile.ModelChannel != "" && r.BuildModel != nil {
		if built, err := r.BuildModel(profile.ModelChannel, profile.Model, reasoningEffort); err == nil && built != nil {
			llm = built
			selectedChannel = profile.ModelChannel
		} else if profile.StrictModel && err != nil {
			// 不向工具结果回显渠道细节或凭据。
			return Result{}, fmt.Errorf("Fusion 执行模型无法初始化")
		}
	}
	if llm == nil {
		return Result{}, fmt.Errorf("IO_ERROR: 子代理模型不可用")
	}
	contextConfig := r.Config
	if contextConfig != nil {
		contextConfig = contextConfig.Clone()
		if selectedChannel != "" {
			contextConfig.ModelChannelID = selectedChannel
		}
		contextConfig.Model = llm.Name()
		if fusion {
			contextConfig.ReasoningEffort = reasoningEffort
		}
	}
	// subSessionID 是每次委派独立的审计/日志身份；Fusion 委派
	// 另有一个按作用域稳定的私有 ADK 会话名，跨交接续用上下文。
	agentName, sessionID, message := "sub-"+profileID, subSessionID, task
	instruction := subInstruction(profile, instructions) + "\n\n" + r.Environment
	checkpoint := ""
	if profile.StrictModel {
		agentName, sessionID = fusionAgentName, "fusion-"+r.FusionScope
		instruction = subInstruction(Profile{Instructions: r.FusionInstruction}, "") + "\n\n" + r.Environment
		message = fmt.Sprintf("本次角色：%s\n\n角色约定：\n%s\n\n任务：\n%s", profileID, profile.Instructions, task)
		if strings.TrimSpace(instructions) != "" {
			message += "\n\n补充指示：\n" + instructions
		}
		checkpoint = filepath.Join(r.SubDir(parentSession), fusionCheckpointFile)
	}
	contextRuntime, err := loopraagent.NewContextRuntime(llm, contextConfig, agentName)
	if err != nil {
		return Result{}, err
	}

	// 普通子代理的审批统一归到匿名的 "sub" 会话；Fusion 执行
	// 模型继承父会话的审批覆盖（会话级 hitl 模式与已授权清单）。
	approvalSession := "sub"
	if profile.StrictModel {
		approvalSession = parentSession
	}
	subTools := r.subTools(profile, approvalSession)
	inMem := session.InMemoryService()
	if contextRuntime.Compaction() != nil {
		reader, err := loopraagent.OriginalToolResultTool(inMem)
		if err != nil {
			return Result{}, err
		}
		subTools = append(subTools, reader)
	}
	// 同主代理：提示词含用户自定义指示与运行环境，
	// 用 InstructionProvider 避开 ADK 对 {} 的会话状态占位符替换。
	instructionProvider := func(agentpkg.ReadonlyContext) (string, error) { return instruction, nil }
	root, err := llmagent.New(llmagent.Config{
		Name:                agentName,
		Model:               contextRuntime.Model(),
		Description:         profile.Description,
		InstructionProvider: instructionProvider,
		Tools:               subTools,
	})
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}
	created, err := inMem.Create(ctx, &session.CreateRequest{
		AppName: "loopra", UserID: "default", SessionID: sessionID,
	})
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}
	if checkpoint != "" {
		if err := restoreFusionCheckpoint(ctx, checkpoint, r.FusionScope, inMem, created.Session); err != nil {
			return Result{}, err
		}
	}
	// 与主代理一致：同一套钩子，并行工具调用完成即上报 sub_tool_result。
	plugins, err := loopraagent.RuntimePlugins(llm)
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}
	run, err := runner.New(runner.Config{
		AppName: "loopra", Agent: root, SessionService: contextRuntime.SessionService(inMem, contextConfig),
		PluginConfig: runner.PluginConfig{Plugins: plugins},
		Compaction:   contextRuntime.Compaction(),
	})
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}

	// Fusion 委派是同步交接：执行时长跟随父轮次的取消与中断，
	// 不套用普通子代理的 subAgentTimeoutSec 执行上限。
	runCtx := ctx
	var timeout time.Duration
	if !fusion {
		timeout = time.Duration(r.TimeoutSec) * time.Second
		if timeout <= 0 {
			timeout = 3600 * time.Second
		}
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	rec := newRecorder(r.SubDir(parentSession))

	started := time.Now().UnixMilli()
	start := map[string]any{
		"type": "sub_start", "subId": subID, "subSessionId": subSessionID,
		"task": task, "name": name, "title": title, "startedAt": started,
	}
	if profile.StrictModel {
		// 只写进 .sub 日志：Fusion 委派只能由主代理发起，执行
		// 记录不进入子会话列表，也不提供人工续聊入口。
		start["resumable"] = false
	}
	rec.record(start)
	send(sink, "sub_start", map[string]any{
		"subId": subID, "subSessionId": subSessionID, "task": task,
		"name": name, "title": title, "startedAt": started,
	})

	status := "completed"
	// 子代理运行在独立的 sub-* 会话里，显式把后台进程归属到父会话，
	// 否则它启动的进程在面板上会挂到用户看不到的会话下。
	owner := tools.SessionOwner{Workspace: r.Workspace, Session: parentSession}
	driveCtx := executionContext(runCtx, contextConfig, owner)
	reply, replyErr := r.drive(driveCtx, run, created.Session, parentSession, message, subID, subSessionID, rec, sink, fusion)
	// 只有成功且未被取消的交接才替换检查点；失败或撤销保留
	// 上一次成功留下的上下文。
	checkpointSaved := false
	if checkpoint != "" && replyErr == nil && runCtx.Err() == nil {
		replyErr = saveFusionCheckpoint(runCtx, checkpoint, r.FusionScope, inMem, created.Session)
		checkpointSaved = replyErr == nil
	}
	if replyErr != nil {
		status = "error"
	}
	// 检查点已原子提交的交接算完成：之后到达的取消不应把
	// 已留进上下文的结果改报成 aborted。
	if !checkpointSaved && runCtx.Err() != nil {
		if ctx.Err() != nil {
			status = "aborted"
			reply = "⏹️ 子代理已取消"
			if fusion {
				reply = "⏹️ 执行已取消"
			}
			replyErr = nil
		} else {
			status = "error"
			replyErr = fmt.Errorf("子代理执行超时（%ds）", int(timeout.Seconds()))
		}
	}
	ended := time.Now().UnixMilli()
	rec.record(map[string]any{
		"type": "sub_end", "subId": subID, "subSessionId": subSessionID,
		"status": status, "endedAt": ended,
	})
	send(sink, "sub_end", map[string]any{
		"subId": subID, "status": status, "endedAt": ended,
	})

	res := Result{SubSessionID: subSessionID, Title: title, Reply: reply, Status: status}
	if status == "completed" && !profile.StrictModel {
		keepResumable(&liveRun{
			owner: owner, imageConfig: contextConfig, subID: subID,
			subSessionID: subSessionID, title: title, runner: run, sess: created.Session,
		})
	}
	return res, replyErr
}

// Resume 用后续消息继续一个已完成的子会话。
func (r *Runner) Resume(ctx context.Context, subSessionID, message string, sink Sink) (string, error) {
	runsMu.Lock()
	prev, ok := resumable[subSessionID]
	runsMu.Unlock()
	if !ok || prev.owner.Workspace != r.Workspace {
		return "", fmt.Errorf("子会话不可续聊或已过期")
	}
	prev.mu.Lock()
	busy := prev.busy
	prev.busy = true
	prev.mu.Unlock()
	if busy {
		return "", fmt.Errorf("子会话正在运行")
	}
	defer func() {
		prev.mu.Lock()
		prev.busy = false
		prev.mu.Unlock()
	}()

	timeout := time.Duration(r.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 3600 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	rec := newRecorder(r.SubDir(prev.owner.Session))
	rec.record(map[string]any{
		"type": "sub_user", "subId": prev.subID, "subSessionId": subSessionID, "content": message,
	})
	driveCtx := executionContext(runCtx, prev.imageConfig, prev.owner)
	reply, driveErr := r.drive(driveCtx, prev.runner, prev.sess, prev.owner.Session, message, prev.subID, subSessionID, rec, sink, false)
	status := "completed"
	if driveErr != nil {
		status = "error"
	}
	if runCtx.Err() != nil {
		status = "aborted"
	}
	end := map[string]any{
		"type": "sub_end", "subId": prev.subID, "subSessionId": subSessionID,
		"status": status, "endedAt": time.Now().UnixMilli(),
	}
	rec.record(end)
	send(sink, "sub_end", end)
	if err := runCtx.Err(); err != nil {
		return reply, err
	}
	return reply, driveErr
}

func executionContext(ctx context.Context, cfg *config.Loopra, owner tools.SessionOwner) context.Context {
	ctx = tools.WithoutAsyncRuntime(ctx)
	ctx = tools.WithFileChanges(ctx, nil)
	ctx = tools.WithImageRuntime(ctx, cfg, nil)
	ctx = tools.WithWorkspaceScope(ctx, cfg != nil && cfg.ToolsRestrictWorkspace)
	return tools.WithSessionOwner(ctx, owner)
}

func keepResumable(run *liveRun) {
	runsMu.Lock()
	if len(resumable) >= 20 && len(resumeOrd) > 0 {
		oldest := resumeOrd[0]
		resumeOrd = resumeOrd[1:]
		delete(resumable, oldest)
	}
	resumable[run.subSessionID] = run
	resumeOrd = append(resumeOrd, run.subSessionID)
	runsMu.Unlock()
}

// subInstruction 组装子代理系统提示词。
func subInstruction(profile Profile, extra string) string {
	sb := strings.Builder{}
	sb.WriteString(profile.Instructions)
	sb.WriteString("\n\n" + loopraagent.ReplyImageInstruction)
	if extra != "" {
		sb.WriteString("\n\n补充指示：\n")
		sb.WriteString(extra)
	}
	return sb.String()
}

// subTools 复制父注册表，并按禁止列表与
// 角色工具策略（显式 allowedTools，或只读集合）过滤。
func (r *Runner) subTools(profile Profile, approvalSession string) []tool.Tool {
	denied := map[string]bool{}
	for _, n := range DenyTools {
		denied[n] = true
	}
	allowed := map[string]bool{}
	unrestricted := true
	if len(profile.AllowedTools) > 0 {
		unrestricted = false
		for _, n := range profile.AllowedTools {
			allowed[tools.ResolveName(n)] = true
		}
	} else if profile.ReadOnly {
		unrestricted = false
		for _, e := range r.Registry.Entries() {
			if e.Meta.ReadOnly {
				allowed[e.Meta.Name] = true
			}
		}
	}
	var out []tool.Tool
	for _, e := range r.Registry.Entries() {
		if denied[e.Meta.Name] || (!unrestricted && !allowed[e.Meta.Name]) {
			continue
		}
		if profile.StrictModel {
			// Fusion 只读角色不获得任何可写工具，角色自己的
			// 允许清单也不能放宽这一约束。
			if profile.ReadOnly && !e.Meta.ReadOnly {
				continue
			}
			// Fusion 执行模型同时遵守会话允许清单，
			// 不能恢复被自定义角色收窄的工具。
			if !r.Registry.Available(e.Meta.Name) {
				continue
			}
		} else if r.Registry.Disabled(e.Meta.Name) {
			continue
		}
		if r.Gate != nil {
			out = append(out, r.Gate(approvalSession, e.Tool))
			continue
		}
		out = append(out, e.Tool)
	}
	return out
}

func send(sink Sink, event string, payload map[string]any) {
	if sink != nil {
		sink.SendSub(event, payload)
	}
}

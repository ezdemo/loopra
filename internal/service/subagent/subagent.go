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
}

// DenyTools 是应用于每个子代理的硬性禁止列表（Java
// SubAgent.SUB_AGENT_DENY）：子代理不能派生子代理，也不能
// 操纵 goals/checklists/plans。
var DenyTools = []string{
	"sub_agent", "checklist_start", "checklist_step", "checklist_status",
	"goal_create", "goal_status", "goal_update_step", "goal_complete",
	"goal_block", "goal_resume", "ask_choice", "submit_plan",
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
	// BuildModel 解析角色的渠道覆盖。
	BuildModel func(channelID, modelName string) (model.LLM, error)
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
	// Gate 在设置时用审批链包装单个工具。
	Gate func(t tool.Tool) tool.Tool
	// Permissions 处理子代理审批（POST /chat/permission 与
	// /chat/sub-hitl/{subId}）；为 nil 时禁用子代理 HITL 暂停。
	Permissions *hitl.Registry
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
	profile, ok := r.Profiles(profileID)
	if !ok || !profile.Enable {
		return Result{}, fmt.Errorf("INVALID_SUB_AGENT_PROFILE: %s", profileID)
	}
	if strings.TrimSpace(name) == "" {
		return Result{}, fmt.Errorf("INVALID_SUB_AGENT_NAME: name 必填")
	}
	if strings.TrimSpace(task) == "" {
		return Result{}, fmt.Errorf("INVALID_SUB_AGENT_TASK: task 必填")
	}

	subID := NextSubID()
	subSessionID := newSubSessionID()
	title := BuildTitle(name, task)

	llm := r.ParentModel
	if profile.ModelChannel != "" && r.BuildModel != nil {
		if built, err := r.BuildModel(profile.ModelChannel, profile.Model); err == nil {
			llm = built
		}
	}
	if llm == nil {
		return Result{}, fmt.Errorf("IO_ERROR: 子代理模型不可用")
	}

	subTools := r.subTools(profile)
	instruction := subInstruction(profile, instructions) + "\n\n" + r.Environment
	// 同主代理：提示词含用户自定义指示与运行环境，
	// 用 InstructionProvider 避开 ADK 对 {} 的会话状态占位符替换。
	instructionProvider := func(agentpkg.ReadonlyContext) (string, error) { return instruction, nil }
	root, err := llmagent.New(llmagent.Config{
		Name:                "sub-" + profileID,
		Model:               llm,
		Description:         profile.Description,
		InstructionProvider: instructionProvider,
		Tools:               subTools,
	})
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}
	inMem := session.InMemoryService()
	created, err := inMem.Create(ctx, &session.CreateRequest{
		AppName: "loopra", UserID: "default", SessionID: subSessionID,
	})
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}
	// 与主代理一致：同一套钩子，并行工具调用完成即上报 sub_tool_result。
	plugins, err := loopraagent.RuntimePlugins(llm)
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}
	run, err := runner.New(runner.Config{
		AppName: "loopra", Agent: root, SessionService: inMem,
		PluginConfig: runner.PluginConfig{Plugins: plugins},
	})
	if err != nil {
		return Result{}, fmt.Errorf("IO_ERROR: %v", err)
	}

	timeout := time.Duration(r.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 3600 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	rec := openRecorder(r.SubDir(parentSession))
	defer rec.close()

	started := time.Now().UnixMilli()
	rec.record(map[string]any{
		"type": "sub_start", "subId": subID, "subSessionId": subSessionID,
		"task": task, "name": name, "title": title, "startedAt": started,
	})
	send(sink, "sub_start", map[string]any{
		"subId": subID, "subSessionId": subSessionID, "task": task,
		"name": name, "title": title, "startedAt": started,
	})

	status := "completed"
	var replyErr error
	reply := r.drive(runCtx, run, created.Session, parentSession, task, subID, subSessionID, rec, sink)
	if runCtx.Err() != nil {
		if ctx.Err() != nil {
			status = "aborted"
			reply = "⏹️ 子代理已取消"
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
	if status == "completed" {
		keepResumable(subID, subSessionID, title, run, created.Session)
	}
	return res, replyErr
}

// Resume 用后续消息继续一个已完成的子会话。
func (r *Runner) Resume(ctx context.Context, subSessionID, message string, sink Sink) (string, error) {
	runsMu.Lock()
	prev, ok := resumable[subSessionID]
	runsMu.Unlock()
	if !ok {
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
	return r.drive(runCtx, prev.runner, prev.sess, "default", message, prev.subID, subSessionID, nil, sink), nil
}

func keepResumable(subID int, subSessionID, title string, run *runner.Runner, sess session.Session) {
	runsMu.Lock()
	if len(resumable) >= 20 && len(resumeOrd) > 0 {
		oldest := resumeOrd[0]
		resumeOrd = resumeOrd[1:]
		delete(resumable, oldest)
	}
	resumable[subSessionID] = &liveRun{
		subID: subID, subSessionID: subSessionID, title: title,
		runner: run, sess: sess,
	}
	resumeOrd = append(resumeOrd, subSessionID)
	runsMu.Unlock()
}

// subInstruction 组装子代理系统提示词。
func subInstruction(profile Profile, extra string) string {
	sb := strings.Builder{}
	sb.WriteString(profile.Instructions)
	if extra != "" {
		sb.WriteString("\n\n补充指示：\n")
		sb.WriteString(extra)
	}
	return sb.String()
}

// subTools 复制父注册表，并按禁止列表与
// 角色工具策略（显式 allowedTools，或只读集合）过滤。
func (r *Runner) subTools(profile Profile) []tool.Tool {
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
		if r.Registry.Disabled(e.Meta.Name) {
			continue
		}
		if r.Gate != nil {
			out = append(out, r.Gate(e.Tool))
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

package controller

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/service/acp"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type chatJob struct {
	ID, Workspace, Session string
	mu                     sync.Mutex
	cancel                 context.CancelFunc
	cancelled              bool
	finished               bool
	stop                   func()
	runtime                *Controller // 由 runtimeState.mu 保护
}

func (j *chatJob) setCancel(cancel context.CancelFunc) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cancel = cancel
	if j.cancelled {
		cancel()
	}
}
func (j *chatJob) abort() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.finished {
		return false
	}
	j.cancelled = true
	if j.cancel != nil {
		j.cancel()
	}
	if j.stop != nil {
		j.stop()
	}
	return true
}

type pendingChatAbort struct {
	Workspace, Session string
	Expires            time.Time
}

func (s *Controller) prunePendingAborts(now time.Time) {
	for id, pending := range s.state.pendingAborts {
		if !now.Before(pending.Expires) {
			delete(s.state.pendingAborts, id)
		}
	}
}

func (s *Controller) admitChat(req *chatRequest) (*chatJob, error) {
	if req.RequestID == "" {
		req.RequestID = newUUIDv4()
	}
	st := s.state
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, ok := st.jobs[req.RequestID]; ok {
		return nil, fmt.Errorf("requestId 已有正在处理的聊天任务")
	}
	for _, job := range st.jobs {
		if job.Workspace == s.agent.App() && job.Session == req.SessionName {
			return nil, fmt.Errorf("当前会话已有正在处理的聊天任务")
		}
	}
	select {
	case st.admitted <- struct{}{}:
	default:
		return nil, fmt.Errorf("聊天任务已满，请稍后重试")
	}
	s.prunePendingAborts(time.Now())
	job := &chatJob{ID: req.RequestID, Workspace: s.agent.App(), Session: req.SessionName}
	if pending, ok := st.pendingAborts[job.ID]; ok &&
		(pending.Workspace == "" || pending.Workspace == job.Workspace) && (pending.Session == "" || pending.Session == job.Session) {
		job.cancelled = true
		delete(st.pendingAborts, job.ID)
	}
	job.stop = func() {
		tools.BashSessionTerminate("", tools.SessionOwner{Workspace: job.Workspace, Session: job.Session})
		s.permissions.Cancel(job.Session)
		s.elicitations.Cancel(job.Session)
		if acp.IsExternal(req.AgentID) {
			s.cancelACP(job.Session)
		}
	}
	st.jobs[job.ID] = job
	s.inflight.Store(job.ID, job)
	return job, nil
}

func (s *Controller) releaseChat(job *chatJob) {
	// Keep the session occupied until cancellation has finished killing its
	// processes, so a late cleanup cannot reach the replacement turn.
	job.mu.Lock()
	defer job.mu.Unlock()
	job.finished = true
	s.state.mu.Lock()
	delete(s.state.jobs, job.ID)
	s.inflight.Delete(job.ID)
	s.state.mu.Unlock()
	<-s.state.admitted
}

func (s *Controller) sessionRunning(name string) string {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	for _, job := range s.state.jobs {
		if job.Workspace == s.agent.App() && job.Session == name {
			return job.ID
		}
	}
	return ""
}

func (s *Controller) turnRuntime(req *chatRequest) (*Controller, error) {
	if req.AgentID != "" && req.AgentID != "native" {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", req.AgentID)
	}
	cfg := s.cfg.Clone()
	settings, err := s.resolveSessionSettings(req.SessionName, map[string]string{"model": req.Model, "modelChannelId": req.ModelChannelID, "reasoningEffort": req.ReasoningEffort})
	if err != nil {
		return nil, err
	}
	meta := s.sessionMetaRead(req.SessionName)
	if values, ok := meta["agentConfig"].(map[string]any); ok {
		if fast, ok := values["fast"].(string); ok {
			cfg.FastMode = fast == "on"
		}
	}
	model, channel, effort := settings["model"].(string), settings["modelChannelId"].(string), settings["reasoningEffort"].(string)
	chat := s.agent != nil && s.chatScoped()
	if chat {
		req.LinkedProjectHashes = nil
	}
	projects, err := s.linkedProjects(s.agent.App(), req.LinkedProjectHashes)
	if err != nil {
		return nil, err
	}
	linkedRoots := projectRoots(projects)
	instruction := s.withMemoryInstruction(s.systemInstructionFor(s.workspaceRoot(), s.agent.App(), projects))
	changed := model != cfg.Model || channel != cfg.ModelChannelID || effort != cfg.ReasoningEffort || cfg.FastMode != s.cfg.FastMode || req.FastMode != nil || len(linkedRoots) > 0 || len(s.linkedProjectRoots) > 0 || strings.TrimSpace(instruction) != s.agent.Instruction()
	var mcpSets []tool.Toolset
	var closers []io.Closer
	if !chat {
		mcpSets, closers = s.turnMcpSets(req.SessionName)
		changed = changed || len(mcpSets) > 0
		// 在新建的轮次中纳入已更新的项目/用户指令。
		for _, path := range []string{filepath.Join(s.home, "loopra.md"), filepath.Join(s.workspaceRoot(), "loopra.md"), filepath.Join(s.workspaceRoot(), "AGENTS.md")} {
			if _, err := os.Stat(path); err == nil {
				changed = true
			}
		}
	}
	if !changed {
		return s, nil
	}
	cfg.Model, cfg.ModelChannelID, cfg.ReasoningEffort = model, channel, effort
	if req.FastMode != nil {
		cfg.FastMode = *req.FastMode
	}
	if _, ok := cfg.ChannelByID(channel); !ok {
		return nil, fmt.Errorf("模型渠道不存在")
	}
	view := *s
	view.cfg = cfg
	view.linkedProjectRoots = linkedRoots
	view.turnClosers = closers
	var sets []tool.Toolset
	if s.registry != nil {
		view.registry = tools.NewRegistry(s.registry.Entries()...)
		view.applyToolConfig()
		sets = []tool.Toolset{view.registry}
	}
	sets = append(sets, mcpSets...)
	a, err := s.agent.Derive(s.agent.App(), cfg, sets, strings.TrimSpace(instruction))
	if err != nil {
		view.closeTurnTools()
		return nil, err
	}
	view.agent = a
	view.installApprovalPolicy()
	if !chat {
		view.installSubRunner()
		view.installControlTools()
	}
	return &view, nil
}

func (s *Controller) prepareTurn(req *chatRequest) (*Controller, error) {
	view, err := s.prepareWorktree(req)
	if err != nil {
		return nil, err
	}
	return view.turnRuntime(req)
}

// prepareWorktree 应用隔离分支模式并返回本轮的工作区视图；
// 原生与外部 ACP 引擎共用。
func (s *Controller) prepareWorktree(req *chatRequest) (*Controller, error) {
	if s.agent != nil && s.chatScoped() {
		return s, nil
	}
	meta := s.sessionMetaRead(req.SessionName)
	worktree := meta["worktreeMode"] == true
	if req.WorktreeMode != nil {
		worktree = *req.WorktreeMode
	}
	view := *s
	if worktree {
		main := s.workspaceRoot()
		if !gitops.IsRepo(main) {
			return nil, fmt.Errorf("项目不是 Git 仓库，无法使用隔离分支模式")
		}
		target := gitops.WorktreePath(s.worktreeBase(), s.agent.App(), req.SessionName)
		if !gitops.IsRegisteredWorktree(main, target) {
			if _, err := os.Stat(target); err == nil {
				return nil, fmt.Errorf("目标目录已存在但不是已注册的 worktree")
			}
			if err := gitops.CreateWorktree(main, target, gitops.SandboxBranch(s.agent.App(), req.SessionName)); err != nil {
				return nil, fmt.Errorf("创建隔离分支失败: %w", err)
			}
		}
		view.cfg = s.cfg.Clone()
		view.cfg.WorkspaceDir = target
		if s.agent != nil {
			view.registry = tools.NewRegistry(append(tools.FileTools(target), tools.BashTools(target)...)...)
			view.attachPluginTools(view.registry)
			a, err := s.agent.Derive(s.agent.App(), view.cfg, []tool.Toolset{view.registry}, view.systemInstruction(target))
			if err != nil {
				return nil, err
			}
			view.agent = a
			view.installApprovalPolicy()
			view.installSubRunner()
			view.installControlTools()
			view.applyToolConfig()
		}
	}
	patch := map[string]any{}
	if req.WorktreeMode != nil {
		patch["worktreeMode"] = *req.WorktreeMode
	}
	if req.MergeMode != "" {
		patch["mergeMode"] = req.MergeMode
	}
	if len(patch) > 0 {
		s.sessionMetaSet(req.SessionName, patch)
	}
	return &view, nil
}

// resolveLinkedProjects 为外部引擎合并项目默认关联与本轮临时关联。
func (s *Controller) resolveLinkedProjects(req *chatRequest) ([]string, error) {
	projects, err := s.linkedProjects(s.agent.App(), req.LinkedProjectHashes)
	return projectRoots(projects), err
}

func (s *Controller) worktreeBase() string {
	if s.cfg.WorktreeBaseDir != "" {
		return s.cfg.WorktreeBaseDir
	}
	return gitops.WorktreeBase(s.home)
}

func withTurnSnapshot(ctx context.Context, id string, hasCode bool) context.Context {
	ctx = jsonl.WithSnapshot(ctx, id)
	if hasCode {
		ctx = jsonl.WithCodeSnapshot(ctx, id)
	}
	return ctx
}

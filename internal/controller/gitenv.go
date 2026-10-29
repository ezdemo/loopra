package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
)

// gitEnvironment 按会话实际生效的工作目录
// 分发 /api/git/environment/* 下的各端点。
func (s *Controller) gitEnvironment(w http.ResponseWriter, r *http.Request, action string) {
	env := s.resolveEnvironment(r.URL.Query().Get("sessionName"))
	// 与 GitController 一致：currentPath 为空时所有需要工作目录的操作都
	// 返回“当前环境不可用”，而不是退回到进程当前目录。
	requireCurrent := func() bool {
		if env.Current == "" {
			message := env.Message
			if message == "" {
				message = "隔离分支尚未创建"
			}
			writeFail(w, http.StatusBadRequest, "当前环境不可用："+message)
			return false
		}
		return true
	}
	switch action {
	case "":
		s.writeEnvironmentStatus(w, env)
	case "status":
		s.gitEnvironmentStatus(w, env)
	case "log":
		s.gitEnvironmentLog(w, r, env)
	case "commit":
		if requireCurrent() {
			s.gitCommitEnvironment(w, r, env.Current)
		}
	case "push":
		s.gitEnvironmentPush(w, env)
	case "toggle":
		if requireCurrent() {
			s.gitToggleAt(w, r, env.Current)
		}
	case "diff-content":
		if requireCurrent() {
			s.gitDiffContent(w, r, env.Current)
		}
	case "working-file-content":
		if requireCurrent() {
			s.gitWorkingFileContent(w, r, env.Current)
		}
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

// environment 是会话解析后实际生效的工作区。
type environment struct {
	Session      string
	AgentRunning bool
	Mode         string // "local" | "worktree" | "unavailable"
	Main         string
	MainBranch   string
	MainDirty    bool
	Current      string // 工作树尚未创建时为空
	Branch       string
	Dirty        bool
	Worktree     string
	Exists       bool
	Message      string
}

// resolveEnvironment 与 WorktreeService.environment 行为一致：开启隔离分支
// 模式后 mode 立即变为 worktree；只有目录存在且已在 git 中注册时
// currentPath 才指向工作树，否则为空。
func (s *Controller) resolveEnvironment(session string) (env environment) {
	env.Session = session
	env.AgentRunning = session != "" && s.sessionRunning(session) != ""
	main := s.workspaceRoot()
	env.Main = main
	if main == "" {
		env.Mode = "unavailable"
		env.Message = "未设置项目"
		return env
	}
	if branch, err := gitops.CurrentBranch(main); err == nil {
		env.MainBranch = branch
	}
	env.MainDirty = gitops.Dirty(main)
	env.Mode = "local"
	env.Current = main
	env.Message = "当前 Agent 使用本地项目"
	if session == "" {
		return env
	}
	if s.sessionMetaRead(session)["worktreeMode"] != true {
		return env
	}
	target := gitops.WorktreePath(s.worktreeBase(), s.agent.App(), session)
	env.Worktree = target
	env.Mode = "worktree"
	env.Current = ""
	if _, statErr := os.Stat(target); statErr == nil && gitops.IsRegisteredWorktree(main, target) {
		env.Exists = true
		env.Current = target
		if branch, err := gitops.CurrentBranch(target); err == nil {
			env.Branch = branch
		}
		env.Dirty = gitops.Dirty(target)
		if env.Dirty {
			env.Message = "Agent 正在使用隔离分支"
		} else {
			env.Message = "隔离分支干净"
		}
		return env
	}
	env.Message = "隔离分支将在会话首次运行时创建"
	return env
}

func (s *Controller) writeEnvironmentStatus(w http.ResponseWriter, env environment) {
	writeOK(w, http.StatusOK, map[string]any{
		"workspaceHash":  s.agent.App(),
		"sessionName":    env.Session,
		"mode":           env.Mode,
		"mainPath":       env.Main,
		"mainBranch":     env.MainBranch,
		"mainDirty":      env.MainDirty,
		"currentPath":    env.Current,
		"currentBranch":  env.Branch,
		"currentDirty":   env.Dirty,
		"worktreeExists": env.Exists,
		"agentRunning":   env.AgentRunning,
		"message":        env.Message,
	})
}

func (s *Controller) gitEnvironmentStatus(w http.ResponseWriter, env environment) {
	// 与 EnvironmentGitStatusDTO 一致：目录不可用时对应字段为 null。
	var mainStatus, currentStatus any
	if env.Main != "" {
		mainView := gitops.StatusAt(env.Main)
		mainStatus = s.gitStatusDTO(env.Main, mainView, false)
		if env.Current == env.Main {
			currentStatus = mainStatus
		}
	}
	if env.Current != "" && env.Current != env.Main {
		currentStatus = s.gitStatusDTO(env.Current, gitops.StatusAt(env.Current), false)
	}
	writeOK(w, http.StatusOK, map[string]any{
		"workspaceHash": s.agent.App(),
		"sessionName":   env.Session,
		"mode":          env.Mode,
		"mainPath":      env.Main,
		"mainBranch":    env.MainBranch,
		"currentPath":   env.Current,
		"currentBranch": env.Branch,
		"main":          mainStatus,
		"current":       currentStatus,
	})
}

func (s *Controller) gitEnvironmentLog(w http.ResponseWriter, r *http.Request, env environment) {
	// 与 GitController 一致：scope 省略时读取 current，大小写不敏感。
	rawScope := strings.TrimSpace(r.URL.Query().Get("scope"))
	scope := strings.ToLower(rawScope)
	if scope != "" && scope != "main" && scope != "current" {
		writeFail(w, http.StatusBadRequest, "scope 只能是 main 或 current")
		return
	}
	dir := env.Current
	if scope == "main" {
		dir = env.Main
	}
	if dir == "" {
		writeFail(w, http.StatusBadRequest, "隔离分支尚未创建")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	commits := gitops.LogAt(dir, limit)
	writeOK(w, http.StatusOK, map[string]any{"commits": commits, "count": len(commits)})
}

func (s *Controller) gitEnvironmentPush(w http.ResponseWriter, env environment) {
	if env.Main == "" {
		writeFail(w, http.StatusBadRequest, "当前环境不可用：未设置项目")
		return
	}
	stdout, stderr, err := gitops.Runner{Dir: env.Main}.Git(gitops.TimeoutPush, "push")
	if err != nil {
		writeFail(w, http.StatusBadRequest, "git push failed: "+stderr)
		return
	}
	message := strings.TrimSpace(stdout)
	if message == "" {
		message = strings.TrimSpace(stderr)
	}
	if message == "" {
		message = "已推送"
	}
	writeOK(w, http.StatusOK, map[string]any{"message": message})
}

// gitWorktreeCreate 实现 POST /api/git/worktree/create（幂等）。
func (s *Controller) gitWorktreeCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceHash string `json:"workspaceHash"`
		SessionName   string `json:"sessionName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	if strings.TrimSpace(body.WorkspaceHash) == "" || strings.TrimSpace(body.SessionName) == "" {
		writeFail(w, http.StatusBadRequest, "workspaceHash 与 sessionName 必填")
		return
	}
	main := s.workspaceRoot()
	if !gitops.IsRepo(main) {
		writeFail(w, http.StatusBadRequest, "项目不是 Git 仓库，无法使用隔离分支模式")
		return
	}
	body.WorkspaceHash = s.agent.App()
	target := gitops.WorktreePath(s.worktreeBase(), body.WorkspaceHash, body.SessionName)
	branch := gitops.SandboxBranch(body.WorkspaceHash, body.SessionName)
	mainBranch, _ := gitops.CurrentBranch(main)
	if _, statErr := os.Stat(target); statErr == nil {
		if gitops.IsRegisteredWorktree(main, target) {
			s.sessionMetaSet(body.SessionName, map[string]any{"worktreeMode": true})
			s.writeWorktreeStatus(w, body.WorkspaceHash, body.SessionName, target, branch, mainBranch)
			return
		}
		writeFail(w, http.StatusBadRequest, "目标目录已存在但不是已注册的 worktree，请手动处理: "+target)
		return
	}
	if err := gitops.CreateWorktree(main, target, branch); err != nil {
		writeFail(w, http.StatusBadRequest, "创建隔离分支失败: "+err.Error())
		return
	}
	s.sessionMetaSet(body.SessionName, map[string]any{"worktreeMode": true})
	s.writeWorktreeStatus(w, body.WorkspaceHash, body.SessionName, target, branch, mainBranch)
}

func (s *Controller) writeWorktreeStatus(w http.ResponseWriter, wsHash, session, target, branch, mainBranch string) {
	dirty := gitops.Dirty(target)
	message := "隔离分支干净"
	if dirty {
		message = "隔离分支有未提交改动"
	}
	writeOK(w, http.StatusOK, map[string]any{
		"workspaceHash": wsHash,
		"sessionName":   session,
		"exists":        true,
		"worktreePath":  target,
		"branch":        branch,
		"dirty":         dirty,
		"mainBranch":    mainBranch,
		"message":       message,
	})
}

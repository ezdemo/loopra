package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/adk/model/provider"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/customagent"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/schedule"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type runtimeState struct {
	mu            sync.Mutex
	configUpdates sync.Mutex
	files         sync.Mutex
	root          *Controller
	configuration ConfigService
	runtimes      map[string]*ProjectRuntime
	current       map[string]string
	jobs          map[string]*chatJob
	pendingAborts map[string]pendingChatAbort
	admitted      chan struct{}
	workers       chan struct{}
	export        *mcpEndpoint
	tunnel        *tunnelState
	permissions   map[string]*hitl.Registry
	schedules     map[string]*schedule.Store
	metadata      *modelMetadataCache
	updater       *updateJob
}

type runtimeContextKey struct{}

func newRuntimeState(s *Controller) *runtimeState {
	st := &runtimeState{root: s, configuration: s.configuration, runtimes: map[string]*ProjectRuntime{}, current: map[string]string{}, jobs: map[string]*chatJob{}, pendingAborts: map[string]pendingChatAbort{}, admitted: make(chan struct{}, 80), workers: make(chan struct{}, 16), export: &mcpEndpoint{}, tunnel: &tunnelState{}}
	st.metadata = &modelMetadataCache{}
	st.updater = &updateJob{}
	if s.agent != nil {
		st.permissions = map[string]*hitl.Registry{s.agent.App(): s.permissions}
		st.schedules = map[string]*schedule.Store{s.agent.App(): s.tasks.Store()}
	} else {
		st.permissions = map[string]*hitl.Registry{}
		st.schedules = map[string]*schedule.Store{}
	}
	return st
}

func (s *Controller) configSnapshot() *config.Loopra {
	return s.state.configuration.Snapshot()
}

func (s *Controller) resolveProject(hash string) (string, error) {
	if hash == "" {
		return s.workspaceRoot(), nil
	}
	if hash == chatWorkspace {
		path := filepath.Join(s.home, "chat-workspace")
		return path, os.MkdirAll(path, 0o755)
	}
	if customagent.IsID(hash) {
		agent, err := s.customAgent(hash)
		if err != nil {
			return "", err
		}
		if agent.ProjectHash == "" {
			path := filepath.Join(s.home, "chat-workspace")
			return path, os.MkdirAll(path, 0o755)
		}
		resolved, err := s.resolveProject(agent.ProjectHash)
		if err != nil {
			return "", fmt.Errorf("绑定的项目不存在")
		}
		return resolved, nil
	}
	if filepath.IsAbs(hash) {
		if info, err := os.Stat(hash); err == nil && info.IsDir() {
			return filepath.Clean(hash), nil
		}
	}
	if hash == "." || hash == ".." || filepath.Base(hash) != hash || strings.ContainsAny(hash, `/\`) {
		return "", fmt.Errorf("项目不存在: %s", hash)
	}
	meta := repository.ReadObject(filepath.Join(s.home, "workspace", hash, "workspace.json"))
	path, _ := meta["path"].(string)
	if path == "" && s.agent != nil && hash == s.agent.App() {
		if s.state.root.agent != nil && hash == s.state.root.agent.App() {
			return s.state.root.workspaceRoot(), nil
		}
		return s.workspaceRoot(), nil
	}
	if path == "" {
		return "", fmt.Errorf("项目不存在: %s", hash)
	}
	return path, nil
}

func (s *Controller) projectRuntime(hash string) (*Controller, error) {
	st := s.state
	st.mu.Lock()
	defer st.mu.Unlock()
	cfg := st.configuration.Snapshot()
	root := st.root
	if filepath.IsAbs(hash) {
		path := filepath.Clean(hash)
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("项目不存在")
		}
		hash = service.WorkspaceHash(path)
		if err := s.registerProject(hash, path); err != nil {
			return nil, err
		}
	}
	path := cfg.WorkspaceDir
	if path == "" {
		path = filepath.Join(s.home, "defaultWorkSpace")
	}
	if hash == "" {
		hash = service.WorkspaceHash(path)
		if root.agent != nil && filepath.Clean(root.workspaceRoot()) == filepath.Clean(path) {
			hash = root.agent.App()
		}
	}
	if cached := st.runtimes[hash]; cached != nil {
		return cached.view(cfg), nil
	}
	resolver := *root
	resolver.cfg = cfg
	resolved, err := resolver.resolveProject(hash)
	if err != nil {
		// 所选项目可能尚未被旧版本收录。
		if hash != service.WorkspaceHash(path) {
			return nil, err
		}
		resolved = path
	}
	if root.agent == nil {
		return nil, fmt.Errorf("Agent 未初始化")
	}
	var profile *customagent.Agent
	if customagent.IsID(hash) {
		profile, err = s.customAgent(hash)
		if err != nil {
			return nil, err
		}
	}
	cfg.WorkspaceDir = resolved
	anchor := *root
	anchor.profile = profile
	// 此时 anchor.agent 仍是根智能体，不能用 chatScoped()，直接按 hash 判定。
	chat := hash == chatWorkspace || (profile != nil && profile.ProjectHash == "")
	reg := tools.NewRegistry()
	instruction := anchor.chatSystemInstruction()
	if chat {
		reg = tools.NewRegistry(tools.ShellTools(os.TempDir())...)
		reg.SetChatScope(true)
	} else {
		reg = tools.NewRegistry(append(tools.FileTools(resolved), tools.BashTools(resolved)...)...)
		if hash == root.agent.App() && root.registry != nil && filepath.Clean(resolved) == filepath.Clean(root.workspaceRoot()) {
			reg = tools.NewRegistry(root.registry.Entries()...)
		}
		instruction = anchor.systemInstructionFor(resolved, hash, nil)
	}
	root.attachPluginTools(reg)
	a, err := root.agent.Derive(hash, cfg, []tool.Toolset{reg}, instruction)
	if err != nil {
		return nil, err
	}
	anchor.cfg, anchor.agent, anchor.registry = cfg, a, reg
	if st.permissions[hash] == nil {
		st.permissions[hash] = hitl.NewRegistry()
	}
	anchor.permissions = st.permissions[hash]
	if st.schedules[hash] == nil {
		st.schedules[hash] = schedule.NewStore(schedule.Path(root.home, hash))
	}
	anchor.tasks = schedule.NewService(st.schedules[hash], root.tasks.Ticker())
	runtime := &anchor
	runtime.installApprovalPolicy()
	if chat {
		runtime.installSkillTools()
	} else {
		runtime.installSubRunner()
		runtime.installControlTools()
	}
	runtime.applyToolConfig()
	st.runtimes[hash] = newProjectRuntime(runtime)
	return runtime, nil
}

const chatWorkspace = "__loopra_chat__"

// customAgent 读取一个自定义智能体定义；不存在或读取失败都会报错。
func (s *Controller) customAgent(id string) (*customagent.Agent, error) {
	if s.agentStore == nil {
		return nil, fmt.Errorf("智能体不存在")
	}
	agent, err := s.agentStore.Get(id)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, fmt.Errorf("智能体不存在")
	}
	return agent, nil
}

// chatScoped 报告当前运行时是否按「无项目」的纯聊天方式装配：内置纯聊天，
// 或未绑定项目的自定义智能体。判定依据是工作区身份而不是 profile 本身，
// 这样项目会话临时套用自定义智能体角色时不会退化成聊天域。
func (s *Controller) chatScoped() bool {
	if s.agent == nil {
		return false
	}
	app := s.agent.App()
	if app == chatWorkspace {
		return true
	}
	if customagent.IsID(app) {
		return s.profile == nil || s.profile.ProjectHash == ""
	}
	return false
}

// agentBlock 把用户为自定义智能体写的角色与要求追加到系统提示词末尾。
func (s *Controller) agentBlock() string {
	if s.profile == nil || strings.TrimSpace(s.profile.Instruction) == "" {
		return ""
	}
	return "\n\n以下是用户为当前智能体「" + s.profile.Name + "」设定的角色与要求，请严格遵循：\n" + s.profile.Instruction
}

// chatInstruction 限定纯聊天的文件操作范围，技能和命令工具保持可用。
const chatInstruction = `你是 Loopra，当前处于纯聊天。
直接回答用户的问题，用对话完成交流。
需要实时网页、代码文档或某个页面的内容时，使用 web 工具：search 搜索网页，code 检索库和 API，fetch 读取 URL。
可以使用技能和终端命令完成用户请求；先用 skillread 读取所需技能规约，按当前 shell 的语法执行命令。
这里没有关联项目。禁止读取、列出、搜索、创建、修改、移动或删除普通目录和文件；仅系统临时目录与技能目录及其配套资源除外。命令默认在系统临时目录执行，临时输入、脚本、中间产物和输出都应放在临时目录，不要写入用户项目、桌面、文档目录或其他普通目录。
技能和命令不能扩大上述目录与文件范围，仍应遵守用户要求和工具审批。不要派生子代理，不要提交计划。需要操作普通目录、文件或项目时，请用户切换到对应项目。`

func (s *Controller) chatSystemInstruction() string {
	var text strings.Builder
	text.WriteString(chatInstruction)
	text.WriteString("\n\n" + agentpkg.ReplyImageInstruction)
	text.WriteString("\n可以通过 memory_search 和 memory 专用工具读取和维护全局长期记忆。")
	fmt.Fprintf(&text, "\n\n命令环境：%s（%s）；系统临时目录：%s。\n技能目录：%s；%s。", shellenv.Current.Name, shellenv.Current.Path, os.TempDir(), filepath.Join(s.home, "skills"), s.agentsSkillsRoot())
	text.WriteString("\n可用技能（先使用 skillread 读取完整规约；可用 skilllist、skillsearch、skillrefresh 查询）：\n")
	for _, entry := range s.globalSkillMetadata() {
		fmt.Fprintf(&text, "- %s: %s\n", entry["scope"], entry["description"])
	}
	text.WriteString(s.agentBlock())
	return text.String()
}

func (s *Controller) systemInstruction(workspace string) string {
	hash := service.WorkspaceHash(workspace)
	if s.agent != nil {
		hash = s.agent.App()
	}
	projects, _ := s.linkedProjects(hash, nil)
	return s.systemInstructionFor(workspace, hash, projects)
}

func (s *Controller) systemInstructionFor(workspace, hash string, projects []linkedProject) string {
	// 按目标工作区身份判定聊天域：项目会话套用未绑定项目的智能体
	// 角色时，profile.ProjectHash 为空但仍是项目上下文。
	if hash == chatWorkspace || (customagent.IsID(hash) && s.profile != nil && s.profile.ProjectHash == "") {
		return s.chatSystemInstruction()
	}
	if projects == nil {
		projects, _ = s.linkedProjects(hash, nil)
	}
	var text strings.Builder
	base := agentpkg.DefaultInstruction
	if s.state != nil && s.state.root.agent != nil {
		base = s.state.root.agent.Instruction()
	}
	text.WriteString(base)
	text.WriteString("\n\n" + agentpkg.ReplyImageInstruction)
	text.WriteString("\n\n")
	text.WriteString(shellenv.Instruction(workspace))
	text.WriteString(projectEnvironment(workspace, projects))
	for _, path := range []string{filepath.Join(s.home, "loopra.md"), filepath.Join(workspace, "loopra.md"), filepath.Join(workspace, "AGENTS.md")} {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			text.WriteString("\n\n")
			text.Write(data)
		}
	}
	text.WriteString("\n\n可用技能（先使用 skillread 读取完整规约）：\n")
	for _, entry := range s.globalSkillMetadata() {
		fmt.Fprintf(&text, "- %s: %s\n", entry["scope"], entry["description"])
	}
	for _, entry := range scanSkills(filepath.Join(workspace, ".loopra", "skills"), "@project-skills") {
		if !s.skillAllowed(fmt.Sprint(entry["scope"])) {
			continue
		}
		fmt.Fprintf(&text, "- %s: %s\n", entry["scope"], entry["description"])
	}
	text.WriteString(s.agentBlock())
	return text.String()
}

func workspaceRequest(path string) bool {
	for _, prefix := range []string{"/api/chat", "/api/agent/", "/api/sessions", "/api/git/", "/api/files/", "/api/snapshots", "/api/schedules", "/api/sub-sessions", "/api/agent-engines/", "/api/shell-terminal/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func (s *Controller) scopeHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api") {
			next.ServeHTTP(w, r)
			return
		}
		view := *s
		view.cfg = s.configSnapshot()
		if workspaceRequest(r.URL.Path) && s.agent != nil {
			hash := r.URL.Query().Get("workspaceHash")
			if r.Body != nil && r.Method != http.MethodGet {
				raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
				if err != nil {
					writeFail(w, http.StatusBadRequest, "请求格式不正确")
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
				var body struct {
					WorkspaceHash string `json:"workspaceHash"`
				}
				if json.Unmarshal(raw, &body) == nil && body.WorkspaceHash != "" {
					hash = body.WorkspaceHash
				}
			}
			scoped, err := s.projectRuntime(hash)
			if err != nil {
				writeFail(w, http.StatusBadRequest, err.Error())
				return
			}
			view = *scoped
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), runtimeContextKey{}, &view)))
	})
}

func (s *Controller) bind(handler func(*Controller, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		view, _ := r.Context().Value(runtimeContextKey{}).(*Controller)
		if view == nil {
			view = s
		}
		handler(view, w, r)
	}
}

func (s *Controller) saveConfig(patch map[string]any) error {
	st := s.state
	st.configUpdates.Lock()
	defer st.configUpdates.Unlock()
	registries := map[*tools.Registry]bool{}
	var cfg *config.Loopra
	err := func() error {
		st.mu.Lock()
		defer st.mu.Unlock()
		var err error
		cfg, err = st.configuration.Update(patch)
		if err != nil {
			return err
		}
		if st.root.registry != nil {
			registries[st.root.registry] = true
		}
		for _, runtime := range st.runtimes {
			if runtime != nil && runtime.registry != nil {
				registries[runtime.registry] = true
			}
		}
		for _, job := range st.jobs {
			if job.runtime != nil && job.runtime.registry != nil {
				registries[job.runtime.registry] = true
			}
		}
		st.runtimes = map[string]*ProjectRuntime{}
		return nil
	}()
	if err != nil {
		return err
	}
	for registry := range registries {
		registry.Configure(cfg.DisabledTools, cfg.AutoWhitelist, cfg.ToolReadOnlyOverrides)
	}
	s.cfg = cfg.Clone()
	return nil
}

func (s *Controller) applyToolConfig() {
	if s.registry == nil || s.cfg == nil {
		return
	}
	s.registry.Configure(s.cfg.DisabledTools, s.cfg.AutoWhitelist, s.cfg.ToolReadOnlyOverrides)
	if s.profile != nil {
		s.registry.SetAllowed(s.profile.Tools)
	}
}

func (s *Controller) currentSession() string {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	return s.state.current[s.agent.App()]
}

func (s *Controller) setCurrentSession(name string) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	s.state.current[s.agent.App()] = name
}

func (s *Controller) hasRunningProject(hash string) bool {
	s.state.mu.Lock()
	for _, job := range s.state.jobs {
		if job.Workspace == hash {
			s.state.mu.Unlock()
			return true
		}
	}
	s.state.mu.Unlock()
	for _, item := range s.reqs.List() {
		if item.ProjectHash == hash && s.reqs.Running(item.ID) {
			return true
		}
	}
	return s.tasks.HasPrefix(hash + ":")
}

func providerChannel(ch config.Channel) provider.Channel {
	out := provider.Channel{ID: ch.ID, Name: ch.Name, BaseURL: ch.BaseURL, APIKey: ch.APIKey, APIProtocol: ch.APIProtocol, SpecialCompatibility: ch.SpecialCompatibility}
	for _, entry := range ch.Models {
		out.Models = append(out.Models, provider.ModelEntry{Name: entry.Name, ContextTokens: entry.ContextTokens, MaxTokens: entry.MaxTokens, ImageInput: entry.ImageInput})
	}
	return out
}

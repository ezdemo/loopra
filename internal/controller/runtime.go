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
	st := &runtimeState{root: s, configuration: s.configuration, runtimes: map[string]*ProjectRuntime{}, current: map[string]string{}, jobs: map[string]*chatJob{}, admitted: make(chan struct{}, 80), workers: make(chan struct{}, 16), export: &mcpEndpoint{}, tunnel: &tunnelState{}}
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
	cfg.WorkspaceDir = resolved
	chat := hash == chatWorkspace
	reg := tools.NewRegistry(tools.WebTools()...)
	instruction := chatInstruction
	if !chat {
		reg = tools.NewRegistry(append(append(tools.FileTools(resolved), tools.BashTools(resolved)...), tools.WebTools()...)...)
		if hash == root.agent.App() && root.registry != nil && filepath.Clean(resolved) == filepath.Clean(root.workspaceRoot()) {
			reg = tools.NewRegistry(root.registry.Entries()...)
		}
		instruction = root.systemInstruction(resolved)
	}
	root.attachPluginTools(reg)
	a, err := root.agent.Derive(hash, cfg, []tool.Toolset{reg}, instruction)
	if err != nil {
		return nil, err
	}
	anchor := *root
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
	if !chat {
		runtime.installSubRunner()
		runtime.installControlTools()
	}
	runtime.applyToolConfig()
	st.runtimes[hash] = newProjectRuntime(runtime)
	return runtime, nil
}

const chatWorkspace = "__loopra_chat__"

// chatInstruction 是纯聊天的系统提示。它不包含项目路径、命令环境和技能清单。
const chatInstruction = `你是 Loopra，当前处于纯聊天。
直接回答用户的问题，用对话完成交流。
需要实时网页、代码文档或某个页面的内容时，使用 web 工具：search 搜索网页，code 检索库和 API，fetch 读取 URL。
这里没有项目、工作区或代码库。不要读写文件，不要执行命令，不要搜索项目代码，不要加载技能，不要派生子代理，不要提交计划。
需要改代码、跑命令或查看项目时，请用户切换到对应项目后再继续。`

func (s *Controller) systemInstruction(workspace string) string {
	if s.agent != nil && s.agent.App() == chatWorkspace {
		return chatInstruction
	}
	var text strings.Builder
	base := agentpkg.DefaultInstruction
	if s.state != nil && s.state.root.agent != nil {
		base = s.state.root.agent.Instruction()
	}
	text.WriteString(base)
	text.WriteString("\n\n")
	text.WriteString(shellenv.Instruction(workspace))
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
		fmt.Fprintf(&text, "- %s: %s\n", entry["scope"], entry["description"])
	}
	return text.String()
}

func workspaceRequest(path string) bool {
	for _, prefix := range []string{"/api/chat", "/api/agent/", "/api/sessions", "/api/git/", "/api/files/", "/api/snapshots", "/api/schedules", "/api/sub-sessions", "/api/agent-engines/"} {
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

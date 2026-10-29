package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/provider"
	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	gitsvc "github.com/ezdemo/looprax/internal/service/git"
)

// gitController 实现 /api/git 相关接口（docs/API_CONTRACT.md §3.10）。
//
// 这些路径仍由同一个通配路由进入：GoFrame 里 /git/* 的优先级高于更具体的
// 兄弟路由，拆开注册会让精确路径打到通配处理器，并改变 405 的 Allow 头。
func (s *Controller) gitController(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/git/")
	if action == "environment" {
		s.gitEnvironment(w, r, "")
		return
	}
	if sub, ok := strings.CutPrefix(action, "environment/"); ok {
		s.gitEnvironment(w, r, sub)
		return
	}
	switch action {
	case "branch":
		s.gitBranch(w)
	case "diff":
		s.gitDiff(w)
	case "status":
		s.gitStatus(w)
	case "log":
		s.gitLog(w, r)
	case "config":
		s.gitConfig(w, r)
	case "init":
		s.gitInit(w, r)
	case "commit":
		s.gitCommit(w, r)
	case "toggle":
		s.gitToggle(w, r)
	case "generate-commit-message":
		s.gitGenerateMessage(w, r, s.workspaceRoot())
	case "generate-environment-commit-message":
		env := s.resolveEnvironment(r.URL.Query().Get("sessionName"))
		if env.Current == "" {
			message := env.Message
			if message == "" {
				message = "隔离分支尚未创建"
			}
			writeFail(w, http.StatusBadRequest, "当前环境不可用："+message)
			return
		}
		s.gitGenerateMessage(w, r, env.Current)
	case "diff-content":
		s.gitDiffContent(w, r, s.workspaceRoot())
	case "file-content":
		s.gitFileContent(w, r, s.workspaceRoot())
	case "working-file-content":
		s.gitWorkingFileContent(w, r, s.workspaceRoot())
	case "worktree/create":
		s.gitWorktreeCreate(w, r)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) gitDefaults() gitsvc.Defaults {
	if s.cfg == nil {
		return gitsvc.Defaults{}
	}
	return gitsvc.Defaults{Model: s.cfg.Model, ModelChannelID: s.cfg.ModelChannelID}
}

func (s *Controller) gitBranch(w http.ResponseWriter) {
	dir := s.workspaceRoot()
	branch, err := gitops.CurrentBranch(dir)
	if err != nil {
		writeFail(w, http.StatusBadRequest, "无法获取 Git 分支信息，目录可能不是 Git 仓库")
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"branch": branch})
}

func (s *Controller) gitDiff(w http.ResponseWriter) {
	dir := s.workspaceRoot()
	branch := "unknown"
	if b, err := gitops.CurrentBranch(dir); err == nil {
		branch = b
	}
	view := gitops.StatusAt(dir)
	writeOK(w, http.StatusOK, map[string]any{
		"branch":    branch,
		"changed":   view.Changed,
		"untracked": view.Untracked,
		"count":     len(view.Changed) + len(view.Untracked),
	})
}

func (s *Controller) gitStatus(w http.ResponseWriter) {
	dir := s.workspaceRoot()
	writeOK(w, http.StatusOK, s.gitStatusDTO(dir, gitops.StatusAt(dir), true))
}

func (s *Controller) gitStatusDTO(dir string, view gitops.StatusView, wrapConfig bool) map[string]any {
	return gitsvc.StatusDTO(dir, view, wrapConfig, s.gitDefaults())
}

func (s *Controller) gitLog(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	commits := gitops.LogAt(s.workspaceRoot(), limit)
	writeOK(w, http.StatusOK, map[string]any{
		"commits": commits, "count": len(commits),
	})
}

func (s *Controller) gitConfig(w http.ResponseWriter, r *http.Request) {
	dir := s.workspaceRoot()
	if r.Method == http.MethodGet {
		writeOK(w, http.StatusOK, gitsvc.AuthorConfig(dir, s.gitDefaults()))
		return
	}
	var body gitsvc.AuthorFile
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "配置格式不正确")
		return
	}
	if strings.TrimSpace(body.AuthorName) == "" || strings.TrimSpace(body.AuthorEmail) == "" {
		writeFail(w, http.StatusBadRequest, "作者名和邮箱不能为空")
		return
	}
	if err := gitsvc.SavePosted(dir, body); err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, gitsvc.AuthorConfig(dir, s.gitDefaults()))
}

func (s *Controller) gitInit(w http.ResponseWriter, r *http.Request) {
	initialCommit := false
	if raw := strings.TrimSpace(r.URL.Query().Get("initialCommit")); raw != "" {
		if value, err := strconv.ParseBool(raw); err == nil {
			initialCommit = value
		}
	} else {
		var body struct {
			InitialCommit bool `json:"initialCommit"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		initialCommit = body.InitialCommit
	}
	result, err := gitsvc.Init(s.workspaceRoot(), initialCommit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, result)
}

func (s *Controller) gitCommit(w http.ResponseWriter, r *http.Request) {
	s.gitCommitAt(w, r, s.workspaceRoot())
}

func (s *Controller) gitCommitAt(w http.ResponseWriter, r *http.Request, dir string) {
	var body gitsvc.CommitInput
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	stdout, err := gitsvc.Commit(dir, body, s.gitDefaults())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"stdout": stdout})
}

func (s *Controller) gitCommitEnvironment(w http.ResponseWriter, r *http.Request, dir string) {
	var body struct {
		Message string   `json:"message"`
		Files   []string `json:"files"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	stdout, err := gitsvc.CommitAll(dir, body.Message, body.Files)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"stdout": stdout})
}

func (s *Controller) gitToggle(w http.ResponseWriter, r *http.Request) {
	s.gitToggleAt(w, r, s.workspaceRoot())
}

func (s *Controller) gitToggleAt(w http.ResponseWriter, r *http.Request, dir string) {
	var raw map[string]any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	path, _ := raw["path"].(string)
	var staged *bool
	if stagedRaw, has := raw["staged"]; has && stagedRaw != nil {
		value, ok := stagedRaw.(bool)
		if !ok {
			writeFail(w, http.StatusBadRequest, "staged 必须为布尔值")
			return
		}
		staged = &value
	}
	clean, state, err := gitsvc.Toggle(dir, path, staged)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"path": clean, "newState": state})
}

func (s *Controller) gitGenerateMessage(w http.ResponseWriter, r *http.Request, dir string) {
	var body struct {
		Files          []string `json:"files"`
		Model          string   `json:"model"`
		ModelChannelID string   `json:"modelChannelId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	files, err := gitsvc.CommitFiles(dir, body.Files)
	if err != nil {
		writeErr(w, err)
		return
	}
	// 请求里的模型优先于项目配置，并写回主工作区的作者文件。
	cfg := gitsvc.AuthorConfig(s.workspaceRoot(), s.gitDefaults())
	if modelName := strings.TrimSpace(body.Model); modelName != "" {
		cfg["model"] = modelName
		cfg["modelChannelId"] = strings.TrimSpace(body.ModelChannelID)
		gitsvc.SaveSelection(s.workspaceRoot(), cfg)
	}
	channel, ok := s.cfg.ChannelByID(cfg["modelChannelId"])
	if !ok || channel.APIKey == "" {
		writeFail(w, http.StatusBadRequest, "请先配置模型 API 密钥")
		return
	}
	llm, err := provider.NewLLM(providerChannel(channel), &provider.Options{Model: cfg["model"], ReasoningEffort: s.cfg.ReasoningEffort})
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	request := &model.LLMRequest{
		Contents: []*genai.Content{userContent(gitsvc.CommitPrompt(dir, files), nil)},
		Config:   &genai.GenerateContentConfig{MaxOutputTokens: 1024},
	}
	message := ""
	for response, err := range llm.GenerateContent(ctx, request, false) {
		if err != nil {
			writeFail(w, http.StatusBadRequest, "AI 生成提交消息失败: "+err.Error())
			return
		}
		if response.Content != nil {
			for _, part := range response.Content.Parts {
				if part != nil && !part.Thought {
					message += part.Text
				}
			}
		}
	}
	message = strings.TrimSpace(message)
	if strings.HasPrefix(message, "```") {
		lines := strings.Split(message, "\n")
		if len(lines) > 2 {
			message = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	if message == "" {
		writeFail(w, http.StatusBadRequest, "模型未返回提交消息")
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"message": message})
}

func (s *Controller) gitDiffContent(w http.ResponseWriter, r *http.Request, dir string) {
	content, err := gitsvc.DiffContentAt(dir, r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, content)
}

func (s *Controller) gitFileContent(w http.ResponseWriter, r *http.Request, dir string) {
	content, err := gitsvc.Show(dir, r.URL.Query().Get("path"), r.URL.Query().Get("ref"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"content": content})
}

func (s *Controller) gitWorkingFileContent(w http.ResponseWriter, r *http.Request, dir string) {
	file, err := gitsvc.WorkingFileAt(dir, r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, file)
}

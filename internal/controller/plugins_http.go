package controller

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/service/plugin"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func (s *Controller) pluginsController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	if s.plugins == nil {
		writeFail(w, http.StatusInternalServerError, "插件宿主未初始化")
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/plugins"), "/")
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if path == "sources" || path == "catalog" {
			s.pluginSourceController(w, r, path)
			return
		}
		if path == "" || path == "external" {
			writeOK(w, http.StatusOK, s.plugins.List())
			return
		}
		if strings.HasPrefix(path, "external/") {
			path = strings.TrimPrefix(path, "external/")
		}
		if path == "schedules" {
			writeOK(w, http.StatusOK, s.plugins.ScheduledTasks())
			return
		}
		if s.servePluginConfig(w, path) || s.servePluginIcon(w, r, path) || s.servePluginUI(w, r, path) {
			return
		}
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	if r.Method != http.MethodPost {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	if path == "install" || path == "external/install" {
		s.installPlugin(w, r)
		return
	}
	if path == "sources" || path == "sources/remove" {
		s.pluginSourceController(w, r, path)
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) > 0 && parts[0] == "external" {
		parts = parts[1:]
	}
	if len(parts) == 3 && parts[0] == "schedules" && parts[2] == "run" {
		s.runPluginSchedule(w, r, parts[1])
		return
	}
	if len(parts) == 3 && parts[2] == "open" && (parts[1] == "ui" || parts[1] == "sidebar" || parts[1] == "menu" || parts[1] == "panel") {
		s.openPluginUI(w, r, parts[0], parts[1])
		return
	}
	if len(parts) != 2 {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	id, action := parts[0], parts[1]
	switch action {
	case "request":
		// Every plugin supplies its own page handler. This never dispatches tools.
		var input struct {
			Action  string             `json:"action"`
			Value   map[string]any     `json:"value"`
			Context plugin.PageContext `json:"context"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			writeFail(w, http.StatusBadRequest, "请求格式无效")
			return
		}
		out, err := s.plugins.Request(r.Context(), id, input.Action, input.Value, input.Context)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, out)
	case "config":
		s.savePluginConfig(w, r, id)
	case "remove", "uninstall":
		if err := s.plugins.Remove(id); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, "插件已卸载: "+id)
	case "toggle":
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			writeFail(w, http.StatusBadRequest, "请求体不能为空")
			return
		}
		view, err := s.plugins.SetEnabled(r.Context(), id, body.Enabled)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, view)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) installPlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source string `json:"source"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Source) == "" {
		writeFail(w, http.StatusBadRequest, "source 不能为空（npm 包名、GitHub 地址或本地路径）")
		return
	}
	view, err := s.plugins.Install(r.Context(), body.Source)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, view)
}

func (s *Controller) bindPluginTools(specs []plugin.BoundTool) {
	entries := s.materializePluginTools(specs)
	s.eachRegistry(func(reg *tools.Registry) {
		s.addPluginEntries(reg, entries)
	})
}

func (s *Controller) unbindPluginTools(names []string) {
	s.eachRegistry(func(reg *tools.Registry) {
		for _, name := range names {
			reg.Remove(name)
		}
	})
}

func (s *Controller) attachPluginTools(reg *tools.Registry) {
	if s == nil || s.plugins == nil || reg == nil {
		return
	}
	s.addPluginEntries(reg, s.materializePluginTools(s.plugins.Bound()))
}

func (s *Controller) addPluginEntries(reg *tools.Registry, entries []tools.Tool) {
	if reg == nil {
		return
	}
	chat := reg.ChatScope()
	for _, entry := range entries {
		if chat && !entry.Meta.Chat {
			continue
		}
		reg.Add(entry)
	}
}

func (s *Controller) materializePluginTools(specs []plugin.BoundTool) []tools.Tool {
	out := make([]tools.Tool, 0, len(specs))
	for _, spec := range specs {
		if spec.Call == nil || spec.Name == "" {
			continue
		}
		cfg := functiontool.Config{Name: spec.Name, Description: spec.Description}
		if len(spec.Parameters) > 0 {
			schema := &jsonschema.Schema{}
			if json.Unmarshal(spec.Parameters, schema) == nil {
				cfg.InputSchema = schema
			}
		}
		call := spec.Call
		toolImpl, err := functiontool.New[map[string]any, map[string]any](cfg, func(ctx agentctx.Context, args map[string]any) (map[string]any, error) {
			if args == nil {
				args = map[string]any{}
			}
			return call(ctx, args)
		})
		if err != nil {
			continue
		}
		out = append(out, tools.Tool{Tool: toolImpl, Meta: tools.Metadata{
			Name: spec.Name, Description: spec.Description, ReadOnly: spec.ReadOnly, AutoApprove: spec.ReadOnly, Chat: spec.Chat,
		}})
	}
	return out
}

func (s *Controller) eachRegistry(fn func(*tools.Registry)) {
	if s == nil || fn == nil {
		return
	}
	seen := map[*tools.Registry]struct{}{}
	add := func(reg *tools.Registry) {
		if reg == nil {
			return
		}
		if _, ok := seen[reg]; ok {
			return
		}
		seen[reg] = struct{}{}
		fn(reg)
	}
	if s.state == nil {
		add(s.registry)
		return
	}
	s.state.mu.Lock()
	root := s.state.root
	runtimes := make([]*ProjectRuntime, 0, len(s.state.runtimes))
	for _, runtime := range s.state.runtimes {
		runtimes = append(runtimes, runtime)
	}
	jobs := make([]*chatJob, 0, len(s.state.jobs))
	for _, job := range s.state.jobs {
		jobs = append(jobs, job)
	}
	s.state.mu.Unlock()
	if root != nil {
		add(root.registry)
	}
	for _, runtime := range runtimes {
		if runtime != nil {
			add(runtime.registry)
		}
	}
	for _, job := range jobs {
		if job != nil && job.runtime != nil {
			add(job.runtime.registry)
		}
	}
}

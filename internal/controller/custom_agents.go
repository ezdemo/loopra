package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/service/customagent"
)

// customAgentBody 与 HTTP 契约一致：tools/skills/connectors 缺省或 null 表示不限制。
type customAgentBody struct {
	Name        string   `json:"name"`
	Instruction string   `json:"instruction"`
	ProjectHash string   `json:"projectHash"`
	Icon        string   `json:"icon"`
	Tools       []string `json:"tools"`
	Skills      []string `json:"skills"`
	Connectors  []string `json:"connectors"`
}

func (b customAgentBody) input() customagent.Input {
	return customagent.Input{
		Name: b.Name, Instruction: b.Instruction, ProjectHash: b.ProjectHash,
		Icon: b.Icon, Tools: b.Tools, Skills: b.Skills, Connectors: b.Connectors,
	}
}

func (s *Controller) customAgentsController(w http.ResponseWriter, r *http.Request) {
	if s.agentStore == nil {
		writeFail(w, http.StatusServiceUnavailable, "智能体存储未初始化")
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		agents, err := s.agentStore.List()
		if err != nil {
			s.customAgentFail(w, err)
			return
		}
		if agents == nil {
			agents = []*customagent.Agent{}
		}
		writeOK(w, http.StatusOK, agents)
	case http.MethodPost:
		body, ok := decodeCustomAgentBody(w, r)
		if !ok {
			return
		}
		agent, err := s.agentStore.Create(body.input(), time.Now().UnixMilli(), s.checkAgentProject)
		if err != nil {
			s.customAgentFail(w, err)
			return
		}
		writeOK(w, http.StatusOK, agent)
	default:
		w.Header().Set("Allow", "GET, HEAD, POST")
		writeFail(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (s *Controller) customAgentController(w http.ResponseWriter, r *http.Request) {
	if s.agentStore == nil {
		writeFail(w, http.StatusServiceUnavailable, "智能体存储未初始化")
		return
	}
	id := r.PathValue("id")
	if !customagent.IsID(id) {
		writeFail(w, http.StatusNotFound, "智能体不存在")
		return
	}
	switch r.Method {
	case http.MethodPut:
		body, ok := decodeCustomAgentBody(w, r)
		if !ok {
			return
		}
		agent, err := s.agentStore.Update(id, body.input(), time.Now().UnixMilli(), s.checkAgentProject)
		if err != nil {
			s.customAgentFail(w, err)
			return
		}
		st := s.state
		st.mu.Lock()
		delete(st.runtimes, id)
		st.mu.Unlock()
		writeOK(w, http.StatusOK, agent)
	case http.MethodDelete:
		if s.hasRunningProject(id) {
			writeFail(w, http.StatusConflict, "智能体有正在运行的会话，无法删除")
			return
		}
		// 先从 agents.json 除名，再清会话目录：agents.json 是列表的唯一来源，
		// 除名后目录残留只是孤儿文件；反过来先删目录若中途失败，会留下仍被
		// 列出但会话已残缺的智能体。
		if err := s.agentStore.Delete(id); err != nil {
			s.customAgentFail(w, err)
			return
		}
		st := s.state
		st.mu.Lock()
		delete(st.runtimes, id)
		delete(st.permissions, id)
		delete(st.schedules, id)
		st.mu.Unlock()
		if err := os.RemoveAll(filepath.Join(s.home, "workspace", id)); err != nil {
			writeFail(w, http.StatusInternalServerError, "智能体已删除，但会话目录清理失败: "+err.Error())
			return
		}
		writeOK(w, http.StatusOK, "智能体已删除")
	default:
		w.Header().Set("Allow", "PUT, DELETE")
		writeFail(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

// customAgentCatalog 返回创建智能体时可选的工具与技能清单。
func (s *Controller) customAgentCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeFail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	pick := func(list []map[string]any) []map[string]any {
		out := make([]map[string]any, 0, len(list))
		for _, entry := range list {
			out = append(out, map[string]any{
				"name": entry["name"], "description": entry["description"], "readOnly": entry["readOnly"],
			})
		}
		sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["name"]) < fmt.Sprint(out[j]["name"]) })
		return out
	}
	var chatTools []map[string]any
	if view, err := s.projectRuntime(chatWorkspace); err == nil && view.registry != nil {
		chatTools = pick(view.registry.List())
	}
	var projectTools []map[string]any
	if root := s.state.root; root != nil && root.registry != nil {
		projectTools = pick(root.registry.List())
	}
	skills := []map[string]any{}
	for _, entry := range s.globalSkillMetadata() {
		skills = append(skills, map[string]any{
			"name": entry["name"], "description": entry["description"], "scope": entry["scope"],
		})
	}
	sort.Slice(skills, func(i, j int) bool { return fmt.Sprint(skills[i]["name"]) < fmt.Sprint(skills[j]["name"]) })
	writeOK(w, http.StatusOK, map[string]any{
		"chatTools": chatTools, "projectTools": projectTools, "skills": skills,
		"connectors": s.customAgentConnectors(),
	})
}

// customAgentConnectors 列出智能体允许清单可选的连接器：已连接（含
// 需重新授权）的内置条目与用户自配的 MCP 服务，同名时以内置为准。
// 未安装的连接器勾选了运行时也不会生效，不列出。
func (s *Controller) customAgentConnectors() []map[string]any {
	out := []map[string]any{}
	if s.connectors != nil {
		for _, conn := range s.connectors.Catalog().Connectors {
			view := s.connectors.View(conn.ID)
			if !view.Connected {
				continue
			}
			out = append(out, map[string]any{"id": conn.ID, "name": conn.Name, "description": conn.Description, "status": view.Status})
		}
	}
	for _, server := range s.mcpView() {
		if s.connectors != nil {
			if _, builtin := s.connectors.Catalog().Find(server.Name); builtin {
				continue
			}
		}
		out = append(out, map[string]any{"id": server.Name, "name": server.Name, "custom": true})
	}
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["name"]) < fmt.Sprint(out[j]["name"]) })
	return out
}

func decodeCustomAgentBody(w http.ResponseWriter, r *http.Request) (customAgentBody, bool) {
	var body customAgentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return body, false
	}
	return body, true
}

// checkAgentProject 要求绑定目标是一个已注册的真实项目。
func (s *Controller) checkAgentProject(hash string) error {
	if hash == chatWorkspace || customagent.IsID(hash) || filepath.IsAbs(hash) || strings.ContainsAny(hash, `/\:`) {
		return fmt.Errorf("绑定的项目不存在")
	}
	if _, err := s.resolveProject(hash); err != nil {
		return fmt.Errorf("绑定的项目不存在")
	}
	return nil
}

func (s *Controller) customAgentFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, customagent.ErrNotFound):
		writeFail(w, http.StatusNotFound, err.Error())
	case errors.Is(err, customagent.ErrStorage):
		writeFail(w, http.StatusInternalServerError, err.Error())
	default:
		writeFail(w, http.StatusBadRequest, err.Error())
	}
}

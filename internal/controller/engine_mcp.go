package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/ezdemo/looprax/internal/repository"
)

type engineMcpPreferences struct {
	Agents map[string]map[string]bool `json:"agents"`
}

func (s *Controller) engineMcpPreferences() engineMcpPreferences {
	prefs := engineMcpPreferences{Agents: map[string]map[string]bool{}}
	raw, _ := os.ReadFile(filepath.Join(s.home, "agent-mcp.json"))
	_ = json.Unmarshal(raw, &prefs)
	if prefs.Agents == nil {
		prefs.Agents = map[string]map[string]bool{}
	}
	return prefs
}

func (s *Controller) engineMcpSettings(w http.ResponseWriter, r *http.Request) {
	agent := r.URL.Query().Get("agentId")
	if agent == "" {
		agent = "native"
	}
	type entry struct {
		Server McpServer
		Source string
	}
	servers := map[string]entry{}
	for _, server := range s.mcpView() {
		servers[server.Name] = entry{server, "global"}
	}
	for _, server := range projectMcpServers(filepath.Join(s.workspaceRoot(), ".loopra", "mcp-servers.json")) {
		servers[server.Name] = entry{server, "project"}
	}
	if r.Method == http.MethodPut {
		var body struct {
			AgentID string `json:"agentId"`
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Name == "" || body.Enabled == nil {
			writeFail(w, http.StatusBadRequest, "MCP 配置不存在，请刷新后重试")
			return
		}
		if body.AgentID != "" {
			agent = body.AgentID
		}
		if _, ok := servers[body.Name]; !ok {
			writeFail(w, http.StatusBadRequest, "MCP 配置不存在，请刷新后重试")
			return
		}
		s.state.files.Lock()
		prefs := s.engineMcpPreferences()
		if prefs.Agents[agent] == nil {
			prefs.Agents[agent] = map[string]bool{}
		}
		prefs.Agents[agent][body.Name] = *body.Enabled
		err := repository.WriteJSON(filepath.Join(s.home, "agent-mcp.json"), prefs)
		s.state.files.Unlock()
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	prefs := s.engineMcpPreferences()
	view := []map[string]any{}
	for _, entry := range servers {
		enabled := entry.Server.Enabled
		if override, ok := prefs.Agents[agent][entry.Server.Name]; ok {
			enabled = override
		}
		view = append(view, map[string]any{"name": entry.Server.Name, "type": entry.Server.Type, "source": entry.Source, "configuredEnabled": entry.Server.Enabled, "enabled": enabled})
	}
	sort.Slice(view, func(i, j int) bool { return view[i]["name"].(string) < view[j]["name"].(string) })
	writeOK(w, http.StatusOK, view)
}

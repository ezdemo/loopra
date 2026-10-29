package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"go.yaml.in/yaml/v3"
)

func scanSkills(root, scope string) []map[string]any {
	out := []map[string]any{}
	dirs, _ := os.ReadDir(root)
	for _, dir := range dirs {
		if !dir.IsDir() {
			continue
		}
		path := filepath.Join(root, dir.Name())
		data, err := os.ReadFile(filepath.Join(path, "SKILL.md"))
		if err != nil {
			continue
		}
		name, description := dir.Name(), ""
		name, description = skillFrontmatter(data, name)
		alias, id := scope, scope+"/"+dir.Name()
		if scope == "project" {
			alias, id = "@project-skills", "project"
		}
		out = append(out, map[string]any{"name": name, "description": description, "scope": id, "runAs": "", "directoryName": dir.Name(), "path": path, "mountAlias": alias})
	}
	return out
}

func skillFrontmatter(data []byte, fallback string) (string, string) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return fallback, ""
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return fallback, ""
	}
	var header struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if yaml.Unmarshal([]byte(text[4:4+end]), &header) != nil {
		return fallback, ""
	}
	if strings.TrimSpace(header.Name) == "" {
		header.Name = fallback
	}
	return header.Name, strings.TrimSpace(header.Description)
}

func (s *Controller) agentDeepController(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("sessionName")
	switch strings.TrimPrefix(r.URL.Path, "/api/agent/") {
	case "mode":
		if r.Method == http.MethodPost {
			var body struct {
				SessionName string `json:"sessionName"`
				Enabled     bool   `json:"enabled"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionName == "" {
				writeFail(w, http.StatusBadRequest, "请先选择会话")
				return
			}
			name = body.SessionName
			patch := map[string]any{"planMode": body.Enabled}
			if !body.Enabled {
				patch["pendingPlan"] = ""
			}
			s.sessionMetaSet(name, patch)
		}
		if name == "" {
			writeFail(w, http.StatusBadRequest, "sessionName 不能为空")
			return
		}
		meta := s.sessionMetaRead(name)
		mode := "execute"
		if meta["planMode"] == true {
			mode = "plan"
		}
		state := map[string]any{"mode": mode}
		if plan := strOr(meta, "pendingPlan", ""); plan != "" {
			state["pendingPlan"] = plan
		}
		writeOK(w, http.StatusOK, state)
	case "acp-state":
		if name == "" {
			writeFail(w, http.StatusBadRequest, "sessionName 不能为空")
			return
		}
		meta := s.sessionMetaRead(name)
		plan, commands := meta["acpPlan"], meta["acpCommands"]
		if plan == nil {
			plan = []any{}
		}
		if commands == nil {
			commands = []any{}
		}
		writeOK(w, http.StatusOK, map[string]any{"plan": plan, "commands": commands})
	case "commands":
		writeOK(w, http.StatusOK, nativeCommandMetadata())
	case "prompt":
		text := s.systemInstruction(s.workspaceRoot())
		writeOK(w, http.StatusOK, map[string]any{"content": text, "length": len(utf16.Encode([]rune(text)))})
	case "skills":
		writeOK(w, http.StatusOK, s.globalSkillMetadata())
	case "project-capabilities", "project-capabilities/refresh":
		root := s.workspaceRoot()
		mcpPath := filepath.Join(root, ".loopra", "mcp-servers.json")
		skillsPath := filepath.Join(root, ".loopra", "skills")
		_, mcpErr := os.Stat(mcpPath)
		skillInfo, skillsErr := os.Stat(skillsPath)
		servers := []map[string]any{}
		for _, server := range projectMcpServers(mcpPath) {
			view := map[string]any{"name": server.Name, "type": server.Type, "enabled": server.Enabled, "loaded": false, "toolCount": 0, "toolNames": []string{}}
			if server.Enabled {
				ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
				entries, err := mcpListTools(ctx, server)
				cancel()
				if err != nil {
					view["error"] = "加载失败"
				} else {
					names := []string{}
					for _, entry := range entries {
						if name, ok := entry["name"].(string); ok {
							names = append(names, name)
						}
					}
					view["loaded"], view["toolCount"], view["toolNames"] = true, len(names), names
				}
			}
			servers = append(servers, view)
		}
		skills := []map[string]any{}
		for _, entry := range scanSkills(skillsPath, "project") {
			skills = append(skills, map[string]any{"name": entry["name"], "description": entry["description"], "scope": "project", "mountAlias": "@project-skills", "path": entry["path"]})
		}
		writeOK(w, http.StatusOK, map[string]any{"workspacePath": root, "mcpConfigPath": mcpPath, "mcpConfigExists": mcpErr == nil, "projectSkillsPath": skillsPath, "projectSkillsDirectoryExists": skillsErr == nil && skillInfo.IsDir(), "skills": skills, "mcpServers": servers})
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func projectMcpServers(path string) []McpServer {
	out := []McpServer{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var file mcpConfigFile
	if json.Unmarshal(data, &file) != nil {
		return out
	}
	// 通过标准 map 相同的默认值解码原生条目。
	var native struct {
		Servers []map[string]any `json:"servers"`
	}
	_ = json.Unmarshal(data, &native)
	for _, raw := range native.Servers {
		out = append(out, externalToServer(raw))
	}
	if len(file.Servers) == 0 && len(file.McpServers) == 0 {
		var bare map[string]map[string]any
		if json.Unmarshal(data, &bare) == nil {
			file.McpServers = bare
		}
	}
	for name, raw := range file.McpServers {
		raw["name"] = name
		server := externalToServer(raw)
		if _, ok := raw["enabled"]; !ok {
			server.Enabled = true
		}
		out = append(out, server)
	}
	return out
}

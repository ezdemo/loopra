package controller

import "path/filepath"

// acpMcpServers 返回该 Agent 启用且可转换的 MCP 定义
// （Java AcpMcpServers.managed(workspace, agentId)）：全局定义被项目定义覆盖，
// Agent 级开关优先于定义自身的 enabled。
func (s *Controller) acpMcpServers(agentID string) []any {
	choices := s.engineMcpPreferences().Agents[agentID]
	merged := map[string]McpServer{}
	for _, server := range s.mcpView() {
		merged[server.Name] = server
	}
	for _, server := range projectMcpServers(filepath.Join(s.workspaceRoot(), ".loopra", "mcp-servers.json")) {
		merged[server.Name] = server
	}
	out := make([]any, 0, len(merged))
	for name, server := range merged {
		enabled := server.Enabled
		if choice, ok := choices[name]; ok {
			enabled = choice
		}
		if !enabled {
			continue
		}
		if definition, ok := acpMcpDefinition(name, server); ok {
			out = append(out, definition)
		}
	}
	return out
}

// acpMcpDefinition 把 Loopra 的 MCP 定义转换成 ACP 会话参数
// （Java AcpMcpServers.toAcp）。
func acpMcpDefinition(name string, server McpServer) (map[string]any, bool) {
	if name == "" {
		return nil, false
	}
	kind := server.Type
	if kind == "" {
		if server.Command == "" {
			kind = "http"
		} else {
			kind = "stdio"
		}
	}
	switch kind {
	case "stdio":
		if server.Command == "" {
			return nil, false
		}
		definition := map[string]any{
			"name": name, "command": server.Command,
			"args": append([]string{}, server.Args...),
		}
		if len(server.Env) > 0 {
			definition["env"] = mcpKeyValues(server.Env)
		}
		return definition, true
	case "http", "streamable", "streamable-http", "streamable_stateless":
		if server.URL == "" {
			return nil, false
		}
		return map[string]any{
			"type": "http", "name": name, "url": server.URL,
			"headers": mcpKeyValues(server.Headers),
		}, true
	case "sse":
		if server.URL == "" {
			return nil, false
		}
		return map[string]any{
			"type": "sse", "name": name, "url": server.URL,
			"headers": mcpKeyValues(server.Headers),
		}, true
	default:
		return nil, false
	}
}

// mcpKeyValues 把 map 渲染成 ACP 的 [{name,value}] 数组。
func mcpKeyValues(values map[string]string) []any {
	out := make([]any, 0, len(values))
	for key, value := range values {
		out = append(out, map[string]any{"name": key, "value": value})
	}
	return out
}

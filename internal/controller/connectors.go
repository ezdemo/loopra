package controller

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/connector"
)

// connectorsController 分发 /api/connectors。
func (s *Controller) connectorsController(w http.ResponseWriter, r *http.Request) {
	if s.connectors == nil {
		writeFail(w, http.StatusServiceUnavailable, "连接器服务不可用")
		return
	}
	action := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/connectors"), "/")
	switch {
	case action == "":
		s.connectorsList(w, r)
	case action == "session":
		s.connectorSession(w, r)
	case action == "custom/probe":
		s.customProbe(w, r)
	case strings.HasPrefix(action, "custom/"):
		s.customAction(w, r, strings.TrimPrefix(action, "custom/"))
	case strings.HasPrefix(action, "flows/"):
		s.connectorFlow(w, r, strings.TrimPrefix(action, "flows/"))
	default:
		s.connectorAction(w, r, action)
	}
}

// connectorsList 输出目录视图：不含传输模板与凭据值，附带连接
// 状态；同时把用户自配的 MCP 服务列为 custom。
func (s *Controller) connectorsList(w http.ResponseWriter, r *http.Request) {
	catalog := s.connectors.Catalog()
	type fieldView struct {
		Key    string `json:"key"`
		Label  string `json:"label"`
		Secret bool   `json:"secret,omitempty"`
	}
	connectors := []map[string]any{}
	for _, conn := range catalog.Connectors {
		view := s.connectors.View(conn.ID)
		fields := []fieldView{}
		for _, f := range conn.Auth.Fields {
			fields = append(fields, fieldView{Key: f.Key, Label: f.Label, Secret: f.Secret})
		}
		met := s.connectors.RequirementsMet(conn)
		status := "available"
		switch {
		case view.Status == connector.StatusConnected:
			status = "connected"
		case view.Status == connector.StatusNeedsReauth:
			status = "needs_reauth"
		case !met:
			status = "missing_requirement"
		}
		connectors = append(connectors, map[string]any{
			"id": conn.ID, "name": conn.Name, "category": conn.Category,
			"color": conn.Color, "description": conn.Description,
			"capabilities": conn.Capabilities, "docsUrl": conn.DocsURL,
			"status": status, "enabled": view.Enabled, "connectedAt": view.ConnectedAt,
			"authType": conn.Auth.Type, "authClient": conn.Auth.Client,
			"fields": fields, "configuredFields": view.ConfiguredFields,
			"helpUrl": conn.Auth.HelpURL, "requires": conn.Requires,
			"requirementsMet": met,
		})
	}
	custom := []map[string]any{}
	for _, server := range s.mcpView() {
		authStatus := "none"
		if server.Type == "streamable" || server.Type == "sse" {
			authStatus = s.connectors.CustomAuthStatus(connector.CustomKey(server.Name))
		}
		entry := map[string]any{
			"name": server.Name, "type": server.Type, "enabled": server.Enabled,
			"disallowedTools": len(server.DisallowedTools), "authStatus": authStatus,
		}
		if server.Type == "stdio" {
			entry["command"] = server.Command
		} else {
			entry["url"] = server.URL
		}
		custom = append(custom, entry)
	}
	writeOK(w, http.StatusOK, map[string]any{
		"categories": catalog.Categories, "connectors": connectors, "custom": custom,
	})
}

// connectorAction 处理 /api/connectors/{id}/{verb}。
func (s *Controller) connectorAction(w http.ResponseWriter, r *http.Request, action string) {
	id, verb, _ := strings.Cut(action, "/")
	if id == "" {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	if _, ok := s.connectors.Catalog().Find(id); !ok {
		writeFail(w, http.StatusBadRequest, "连接器不存在: "+id)
		return
	}
	switch verb {
	case "connect":
		if r.Method != http.MethodPost {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		s.connectorConnect(w, r, id)
	case "toggle":
		if r.Method != http.MethodPost {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeFail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
		if err := s.connectors.Toggle(id, body.Enabled); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"enabled": body.Enabled})
	case "disconnect":
		if r.Method != http.MethodPost {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		if err := s.connectors.Disconnect(id); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, "已断开连接")
	case "tools":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 GET")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		tools, err := s.connectors.ListTools(ctx, id)
		if err != nil {
			writeOK(w, http.StatusOK, map[string]any{"connected": false, "tools": []any{}})
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"connected": true, "tools": tools})
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

// connectorConnect 处理连接请求：token/credentials 直接校验并
// 探测工具；oauth 启动授权流程返回授权 URL。
func (s *Controller) connectorConnect(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Fields map[string]string `json:"fields"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	conn, _ := s.connectors.Catalog().Find(id)
	if conn.Auth.Type == "oauth" {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		flowID, url, err := s.connectors.StartAuthorization(ctx, id, body.Fields)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"flowId": flowID, "authorizationUrl": url})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	count, err := s.connectors.ConnectCredentials(ctx, id, body.Fields)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"status": connector.StatusConnected, "toolCount": count})
}

// connectorFlow 处理 /api/connectors/flows/{id} 与
// /api/connectors/flows/{id}/cancel。
func (s *Controller) connectorFlow(w http.ResponseWriter, r *http.Request, action string) {
	flowID, verb, _ := strings.Cut(action, "/")
	if verb == "cancel" {
		if r.Method != http.MethodPost {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		s.connectors.CancelFlow(flowID)
		writeOK(w, http.StatusOK, "已取消")
		return
	}
	if verb != "" {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeFail(w, http.StatusMethodNotAllowed, "仅支持 GET")
		return
	}
	view, ok := s.connectors.FlowStatus(flowID)
	if !ok {
		writeFail(w, http.StatusNotFound, "流程不存在或已过期")
		return
	}
	writeOK(w, http.StatusOK, view)
}

// connectorSession 处理会话级连接器开关：
// GET /api/connectors/session?sessionName=X；
// PUT /api/connectors/session {sessionName, id, enabled|null}。
// 覆盖保存在会话 .meta 的 connectors 键下。
func (s *Controller) connectorSession(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		session := r.URL.Query().Get("sessionName")
		overrides := s.connectorSessionOverrides(session)
		out := []map[string]any{}
		for _, conn := range s.connectors.Catalog().Connectors {
			view := s.connectors.View(conn.ID)
			if view.Status != connector.StatusConnected && view.Status != connector.StatusNeedsReauth {
				continue
			}
			entry := map[string]any{
				"id": conn.ID, "name": conn.Name, "enabled": view.Enabled,
			}
			if override, ok := overrides[conn.ID]; ok {
				entry["override"] = override
				entry["enabled"] = override
			}
			out = append(out, entry)
		}
		for _, server := range s.mcpView() {
			// 与目录同名的内置连接器优先，不重复列出。
			if _, builtin := s.connectors.Catalog().Find(server.Name); builtin {
				continue
			}
			override, overridden := overrides[server.Name]
			if !server.Enabled && !overridden {
				continue
			}
			entry := map[string]any{
				"id": server.Name, "name": server.Name, "custom": true,
				"enabled": server.Enabled,
			}
			if overridden {
				entry["override"] = override
				entry["enabled"] = override
			}
			out = append(out, entry)
		}
		writeOK(w, http.StatusOK, out)
	case http.MethodPut:
		var body struct {
			SessionName string `json:"sessionName"`
			ID          string `json:"id"`
			Enabled     *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionName == "" || body.ID == "" {
			writeFail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
		if _, ok := s.connectors.Catalog().Find(body.ID); !ok {
			// 目录外的 id 允许匹配已存在的自定义 MCP 服务名。
			if _, found := s.mcpFind(body.ID); !found {
				writeFail(w, http.StatusBadRequest, "连接器不存在: "+body.ID)
				return
			}
		}
		s.sessionMetaUpdate(body.SessionName, func(meta map[string]any) {
			overrides, _ := meta["connectors"].(map[string]any)
			if overrides == nil {
				overrides = map[string]any{}
			}
			if body.Enabled == nil {
				delete(overrides, body.ID)
			} else {
				overrides[body.ID] = *body.Enabled
			}
			meta["connectors"] = overrides
		})
		writeOK(w, http.StatusOK, map[string]any{"id": body.ID, "enabled": body.Enabled})
	default:
		writeFail(w, http.StatusMethodNotAllowed, "仅支持 GET 与 PUT")
	}
}

// customProbe 探测一个尚未保存的自定义服务器配置：成功返回
// 工具数；远程服务在匿名 initialize 返回 Bearer 挑战时报告
// authRequired，让前端转入 OAuth 登录流程。
func (s *Controller) customProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
		return
	}
	var body struct {
		Server McpServer `json:"server"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "服务器配置格式不正确")
		return
	}
	server := body.Server
	if server.Name == "" {
		server.Name = "probe"
	}
	if err := server.validate(); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	redact := s.customRedactor(server)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if tools, err := mcpListTools(ctx, server); err == nil {
		writeOK(w, http.StatusOK, map[string]any{"ok": true, "toolCount": len(tools)})
		return
	} else {
		logging.Debugf("connectors", "custom probe %s failed: %s", server.Name, redact(err.Error()))
	}
	if server.Type == "streamable" || server.Type == "sse" {
		if mcpAuthRequired(ctx, server) {
			writeOK(w, http.StatusOK, map[string]any{"authRequired": true})
			return
		}
	}
	writeOK(w, http.StatusOK, map[string]any{"ok": false, "error": "连接失败，请检查服务器配置"})
}

// mcpAuthRequired 用匿名 initialize 请求探测远程服务是否要求
// Bearer 授权（401 + WWW-Authenticate: Bearer）。
func mcpAuthRequired(ctx context.Context, server McpServer) bool {
	payload := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"loopra-probe","version":"1.0.0"}}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusUnauthorized &&
		strings.Contains(strings.ToLower(resp.Header.Get("WWW-Authenticate")), "bearer")
}

// customAction 处理 /api/connectors/custom/{name}/{verb}：
// authorize 发起 OAuth（DCR），signout 清除已存凭据。
func (s *Controller) customAction(w http.ResponseWriter, r *http.Request, action string) {
	name, verb, _ := strings.Cut(action, "/")
	if name == "" || verb == "" {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	server, ok := s.mcpFind(name)
	if !ok {
		writeFail(w, http.StatusBadRequest, "服务器不存在: "+name)
		return
	}
	key := connector.CustomKey(name)
	switch verb {
	case "authorize":
		if r.Method != http.MethodPost {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		spec := connector.Spec{
			Name: key, Type: server.Type, URL: server.URL,
			Headers: server.Headers,
		}
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		flowID, url, err := s.connectors.StartCustomAuthorization(ctx, key, spec)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"flowId": flowID, "authorizationUrl": url})
	case "signout":
		if r.Method != http.MethodPost {
			writeFail(w, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		if err := s.connectors.ClearCustom(key); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		writeOK(w, http.StatusOK, "已退出登录")
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

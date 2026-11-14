package controller

import (
	"fmt"
	"io"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/service/connector"
	"github.com/ezdemo/looprax/internal/service/tools"
	"github.com/ezdemo/looprax/internal/service/toolsearch"
)

// connectorSessionName 取工具调用所属的会话名（与 sub_agent 同一机制）。
func connectorSessionName(ctx agentctx.Context) string {
	if v, ok := ctx.Value(sessionKey{}).(string); ok && v != "" {
		return v
	}
	return "default"
}

// connectorEffectiveEnabled 返回会话生效启用值：会话覆盖 ?? 全局 enabled。
func (s *Controller) connectorEffectiveEnabled(session, id string) bool {
	view := s.connectors.View(id)
	if override, ok := s.connectorSessionOverrides(session)[id]; ok {
		return override
	}
	return view.Enabled
}

// connectorStatusFor 供 connector_list / connector_request 共用的状态判定。
func (s *Controller) connectorStatusFor(conn connector.Connector) string {
	view := s.connectors.View(conn.ID)
	switch view.Status {
	case connector.StatusConnected:
		return "connected"
	case connector.StatusNeedsReauth:
		return "needs_reauth"
	}
	if !s.connectors.RequirementsMet(conn) {
		return "missing_requirement"
	}
	return "available"
}

// turnSetKey 通过请求上下文传递本轮的工具搜索集，使
// connector_request 能把刚连上的连接器源热加入当前轮次。
// 注意工具闭包捕获的是常驻 Controller，而搜索集属于每轮的
// view，因此必须走上下文而不是字段。
type turnSetKey struct{}

// hotAddConnector 把刚连上的连接器源加入本轮工具搜索集；本轮
// 没有集合（例如纯聊天）时静默跳过，下一轮自然会带上。
func (s *Controller) hotAddConnector(ctx agentctx.Context, session, id string) {
	turnSet, _ := ctx.Value(turnSetKey{}).(*toolsearch.Set)
	if turnSet == nil {
		return
	}
	conn, ok := s.connectors.Catalog().Find(id)
	if !ok {
		return
	}
	spec, handler, err := s.connectors.Runtime(id)
	if err != nil {
		return
	}
	server := McpServer{
		Name: conn.ID, Type: spec.Type, Enabled: true,
		Command: spec.Command, Args: spec.Args, Env: spec.Env,
		URL: spec.URL, Headers: spec.Headers, OAuth: handler,
	}
	source, err := s.connectorSource(session, server)
	if err != nil {
		return
	}
	if err := turnSet.AddSource(source); err != nil {
		if closer, ok := source.Toolset.(io.Closer); ok {
			_ = closer.Close()
		}
	}
}

// installConnectorTools 注册连接器的模型侧工具；模型通过它们查询、
// 请求和管理连接器。需要连接器服务与注册表都存在。
func (s *Controller) installConnectorTools() {
	if s.registry == nil || s.connectors == nil {
		return
	}

	list, _ := functiontool.New[struct{}, map[string]any](functiontool.Config{
		Name:        "connector_list",
		Description: "列出可连接的服务（地图、文档、邮件等）及其状态。需要查找可用服务、判断服务是否已连接或本会话已启用时使用。",
	}, func(ctx agentctx.Context, in struct{}) (map[string]any, error) {
		session := connectorSessionName(ctx)
		out := []map[string]any{}
		for _, conn := range s.connectors.Catalog().Connectors {
			status := s.connectorStatusFor(conn)
			capabilities := conn.Capabilities
			if capabilities == nil {
				capabilities = []string{}
			}
			out = append(out, map[string]any{
				"id": conn.ID, "name": conn.Name, "description": conn.Description,
				"capabilities": capabilities, "status": status,
				"enabledForSession": status == "connected" && s.connectorEffectiveEnabled(session, conn.ID),
			})
		}
		// 自定义 MCP 服务与内置连接器并列返回；同名时以内置为准。
		overrides := s.connectorSessionOverrides(session)
		for _, server := range s.mcpView() {
			if _, builtin := s.connectors.Catalog().Find(server.Name); builtin {
				continue
			}
			status := "connected"
			if s.connectors.CustomAuthStatus(connector.CustomKey(server.Name)) == "needs_reauth" {
				status = "needs_reauth"
			}
			enabled := server.Enabled
			if override, ok := overrides[server.Name]; ok {
				enabled = override
			}
			out = append(out, map[string]any{
				"id": server.Name, "name": server.Name, "custom": true,
				"capabilities":      []string{},
				"status":            status,
				"enabledForSession": status == "connected" && enabled,
			})
		}
		return map[string]any{"connectors": out}, nil
	})
	s.registry.Add(tools.Tool{Tool: list, Meta: tools.Metadata{Name: list.Name(), Description: list.Description(), ReadOnly: true, AutoApprove: true}})

	type requestInput struct {
		ConnectorID string `json:"connectorId" jsonschema:"connector_list 返回的服务 id"`
		Reason      string `json:"reason" jsonschema:"向用户说明为什么需要这个服务"`
	}
	request, _ := functiontool.New[requestInput, map[string]any](functiontool.Config{
		Name: "connector_request",
		Description: "任务需要某个尚未连接或未启用的服务时调用，向用户请求连接；会暂停等待用户在弹出的卡片里完成连接。" +
			"服务已连接并启用时不要调用。取消或拒绝后不要再次请求同一服务。",
	}, func(ctx agentctx.Context, in requestInput) (map[string]any, error) {
		session := connectorSessionName(ctx)
		conn, ok := s.connectors.Catalog().Find(in.ConnectorID)
		if !ok {
			return map[string]any{"connected": false, "error": "服务不存在"}, nil
		}
		status := s.connectorStatusFor(conn)
		if status == "connected" && s.connectorEffectiveEnabled(session, conn.ID) {
			return map[string]any{"connected": true}, nil
		}
		if status == "missing_requirement" {
			return map[string]any{"connected": false, "error": "该服务需要 Node.js 运行环境"}, nil
		}
		needs := "connect"
		switch status {
		case "connected":
			needs = "enable"
		case "needs_reauth":
			needs = "reauth"
		}
		schema := map[string]any{
			"type": "object", "properties": map[string]any{},
			"x-loopra-connector": map[string]any{
				"id": conn.ID, "name": conn.Name, "reason": in.Reason, "needs": needs,
			},
		}
		item := s.elicitations.Register(session, fmt.Sprintf("需要使用 %s：%s", conn.Name, in.Reason), schema)
		if sink := sinkFromContext(ctx); sink != nil {
			sink.SendSub("elicitation", item.Event())
		}
		answer, _ := s.elicitations.Wait(ctx, item)
		if sink := sinkFromContext(ctx); sink != nil {
			sink.SendSub("elicitation_resolved", map[string]any{
				"elicitationRequestId": item.ID, "action": answer.Action,
			})
		}
		if answer.Action != "accept" {
			return map[string]any{"connected": false}, nil
		}
		if s.connectorStatusFor(conn) != "connected" || !s.connectorEffectiveEnabled(session, conn.ID) {
			return map[string]any{"connected": false}, nil
		}
		s.hotAddConnector(ctx, session, conn.ID)
		return map[string]any{
			"connected": true,
			"note":      "现在可用 tool_search 搜索 " + conn.ID + " 的工具",
		}, nil
	})
	s.registry.Add(tools.Tool{Tool: request, Meta: tools.Metadata{Name: request.Name(), Description: request.Description(), ReadOnly: true, AutoApprove: true}})

	type enableInput struct {
		ConnectorID string `json:"connectorId" jsonschema:"connector_list 返回的服务 id"`
		Enabled     bool   `json:"enabled" jsonschema:"true 启用，false 停用"`
		Scope       string `json:"scope,omitempty" jsonschema:"session（仅本会话，默认）或 global（全局默认状态）"`
	}
	setEnabled, _ := functiontool.New[enableInput, map[string]any](functiontool.Config{
		Name:        "connector_set_enabled",
		Description: "启用或停用某个已连接服务。scope 为 session 时只影响本会话，global 修改全局默认状态。",
	}, func(ctx agentctx.Context, in enableInput) (map[string]any, error) {
		conn, ok := s.connectors.Catalog().Find(in.ConnectorID)
		custom := false
		id := in.ConnectorID
		if !ok {
			server, found := s.mcpFind(in.ConnectorID)
			if !found {
				return nil, fmt.Errorf("服务不存在")
			}
			custom = true
			id = server.Name
		}
		if in.Scope == "global" {
			if custom {
				server, _ := s.mcpFind(id)
				server.Enabled = in.Enabled
				s.mcpUpsert(id, server)
				s.mcpPersist()
				return map[string]any{"enabled": in.Enabled, "scope": "global"}, nil
			}
			if err := s.connectors.Toggle(conn.ID, in.Enabled); err != nil {
				return nil, err
			}
			return map[string]any{"enabled": s.connectors.View(conn.ID).Enabled, "scope": "global"}, nil
		}
		session := connectorSessionName(ctx)
		s.sessionMetaUpdate(session, func(meta map[string]any) {
			overrides, _ := meta["connectors"].(map[string]any)
			if overrides == nil {
				overrides = map[string]any{}
			}
			overrides[id] = in.Enabled
			meta["connectors"] = overrides
		})
		return map[string]any{"enabled": in.Enabled, "scope": "session"}, nil
	})
	s.registry.Add(tools.Tool{Tool: setEnabled, Meta: tools.Metadata{Name: setEnabled.Name(), Description: setEnabled.Description()}})

	type disconnectInput struct {
		ConnectorID string `json:"connectorId" jsonschema:"connector_list 返回的服务 id"`
	}
	disconnect, _ := functiontool.New[disconnectInput, map[string]any](functiontool.Config{
		Name: "connector_disconnect",
		Description: "断开某个服务并删除已保存的凭据。内置连接器仍保留在目录中，可以随时重新连接。" +
			"仅在用户明确要求断开时调用。",
	}, func(ctx agentctx.Context, in disconnectInput) (map[string]any, error) {
		conn, ok := s.connectors.Catalog().Find(in.ConnectorID)
		if !ok {
			return nil, fmt.Errorf("服务不存在")
		}
		if err := s.connectors.Disconnect(conn.ID); err != nil {
			return nil, err
		}
		return map[string]any{"connected": false}, nil
	})
	s.registry.Add(tools.Tool{Tool: disconnect, Meta: tools.Metadata{Name: disconnect.Name(), Description: disconnect.Description()}})
}

package controller

import (
	"context"
	"fmt"
	"net/http"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/acp"
)

// prepareExternalEngine 为外部 ACP 引擎准备会话：绑定 agentId、
// 建立 Agent 会话并返回其配置项。
func (s *Controller) prepareExternalEngine(w http.ResponseWriter, r *http.Request, name, agentID string) {
	meta := s.sessionMetaRead(name)
	bound := strOr(meta, "agentId", "")
	if bound != "" && bound != agentID && len(s.sessionMessages(r.Context(), name)) > 0 {
		writeFail(w, http.StatusConflict, "已有消息的会话不能切换 Agent，请新建会话")
		return
	}
	s.sessionMetaSet(name, map[string]any{"agentId": agentID})
	conn, err := s.acquireACP(r.Context(), name, agentID)
	if err != nil {
		writeFail(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	fresh := len(s.sessionMessages(r.Context(), name)) == 0
	options, err := s.openACPSession(r.Context(), name, conn, false)
	if err != nil {
		writeFail(w, http.StatusInternalServerError, acp.TranslateFailure(err).Error())
		return
	}
	// 仅新会话套用全局偏好；已有会话的配置由 restoreAgentConfig 恢复。
	if fresh {
		s.applyAgentPreferences(r.Context(), name, agentID)
	}
	if latest := conn.ConfigOptions(); len(latest) > 0 {
		options = latest
	} else if latest := conn.Client().ConfigOptions(); len(latest) > 0 {
		options = latest
	}
	writeOK(w, http.StatusOK, map[string]any{
		"sessionName": name, "agentId": agentID, "configOptions": options,
	})
}

// acpConfigOptions 返回（必要时先建立）外部会话的配置项。
func (s *Controller) acpConfigOptions(ctx context.Context, name string) ([]acp.ConfigOption, error) {
	agentID := strOr(s.sessionMetaRead(name), "agentId", "")
	if !acp.IsExternal(agentID) {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	conn, err := s.acquireACP(ctx, name, agentID)
	if err != nil {
		return nil, err
	}
	conn.Use()
	if conn.SessionID() != "" {
		return conn.ConfigOptions(), nil
	}
	return s.openACPSession(ctx, name, conn, false)
}

// setACPConfigOption 更新外部会话配置；旧版 Agent 的 mode/model
// 走 set_mode / set_model。
func (s *Controller) setACPConfigOption(ctx context.Context, name, id string, value any) ([]acp.ConfigOption, error) {
	agentID := strOr(s.sessionMetaRead(name), "agentId", "")
	if !acp.IsExternal(agentID) {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	conn, err := s.acquireACP(ctx, name, agentID)
	if err != nil {
		return nil, err
	}
	conn.Use()
	if conn.SessionID() == "" {
		if _, err := s.openACPSession(ctx, name, conn, false); err != nil {
			return nil, err
		}
	}
	if !conn.Client().ConfigOptionsSupported() {
		switch id {
		case "mode":
			if err := conn.Client().SetMode(ctx, fmt.Sprint(value)); err != nil {
				return nil, err
			}
		case "model":
			if err := conn.Client().SetModel(ctx, fmt.Sprint(value)); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("Agent 不支持此配置: %s", id)
		}
		s.sessionMetaSet(name, map[string]any{"agentConfig": map[string]any{id: fmt.Sprint(value)}})
		conn.BindSession(conn.SessionID(), conn.Client().ConfigOptions())
		return conn.ConfigOptions(), nil
	}
	options, err := conn.Client().SetConfigOption(ctx, id, value)
	if err != nil {
		return nil, err
	}
	conn.BindSession(conn.SessionID(), options)
	s.sessionMetaSet(name, map[string]any{"agentConfig": acp.ConfigValues(options)})
	return options, nil
}

// applyAgentPreferences 在准备会话时套用该 Agent 的上次选择。
func (s *Controller) applyAgentPreferences(ctx context.Context, name, agentID string) {
	prefs := s.enginePreferencesRead()
	agents, _ := prefs["agents"].(map[string]any)
	values, _ := agents[agentID].(map[string]any)
	if len(values) == 0 {
		return
	}
	current := map[string]string{}
	if options, err := s.acpConfigOptions(ctx, name); err == nil {
		for _, option := range options {
			current[option.ID] = fmt.Sprint(option.CurrentValue)
		}
	}
	for id, value := range values {
		if id == "plan" || current[id] == fmt.Sprint(value) {
			continue
		}
		if _, err := s.setACPConfigOption(ctx, name, id, value); err != nil {
			// 某个保存值已不再被该 Agent 接受时忽略，不阻塞准备流程。
			continue
		}
	}
}

// persistAgentPreferences 保存外部 Agent 当前配置，供下次准备时套用。
func (s *Controller) persistAgentPreferences(name, agentID string) {
	if !acp.IsExternal(agentID) {
		return
	}
	options, err := s.acpConfigOptions(context.Background(), name)
	if err != nil {
		return
	}
	values := map[string]any{}
	for _, option := range options {
		values[option.ID] = option.CurrentValue
	}
	s.state.files.Lock()
	prefs := s.enginePreferencesRead()
	agents, _ := prefs["agents"].(map[string]any)
	if agents == nil {
		agents = map[string]any{}
	}
	agents[agentID] = values
	prefs["agents"] = agents
	_ = repository.WriteJSON(s.enginePreferencesPath(), prefs)
	s.state.files.Unlock()
}

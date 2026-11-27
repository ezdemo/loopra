package controller

import (
	"context"
	"fmt"
	"net/http"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/acp"
)

func writeACPFailure(w http.ResponseWriter, status int, err error) {
	failure := acp.TranslateFailure(err)
	if reason := acp.FailureReason(failure); reason != "" {
		writeFailReason(w, http.StatusConflict, failure.Error(), reason)
		return
	}
	writeFail(w, status, failure.Error())
}

// prepareExternalEngine 为外部 ACP 引擎准备会话：绑定 agentId、
// 建立 Agent 会话并返回其配置项。
func (s *Controller) prepareExternalEngine(w http.ResponseWriter, r *http.Request, name, agentID string) {
	scoped, err := s.prepareACPWorkspace(&chatRequest{SessionName: name})
	if err != nil {
		writeACPFailure(w, http.StatusInternalServerError, err)
		return
	}
	s = scoped
	meta := s.sessionMetaRead(name)
	bound := strOr(meta, "agentId", "")
	if bound != "" && bound != agentID && len(s.sessionMessages(r.Context(), name)) > 0 {
		writeFail(w, http.StatusConflict, "已有消息的会话不能切换 Agent，请新建会话")
		return
	}
	s.sessionMetaSet(name, map[string]any{"agentId": agentID})
	conn, err := s.acquireACP(r.Context(), name, agentID)
	if err != nil {
		writeACPFailure(w, http.StatusServiceUnavailable, err)
		return
	}
	fresh := len(s.sessionMessages(r.Context(), name)) == 0
	options, err := s.openACPSession(r.Context(), name, conn, false)
	if err != nil {
		writeACPFailure(w, http.StatusInternalServerError, err)
		return
	}
	// 仅新会话套用全局偏好；已有会话的配置由 ApplyAgentConfig 恢复。
	if fresh {
		options = s.applyAgentPreferences(r.Context(), name, agentID, conn, options)
	}
	// 只用本会话自己的配置：conn.Client().ConfigOptions() 是进程上最后一次
	// 操作的快照，共享进程时可能属于别的会话，不能替本会话兜底。
	if latest := conn.ConfigOptions(); latest != nil {
		options = latest
	}
	writeOK(w, http.StatusOK, map[string]any{
		"sessionName": name, "agentId": agentID, "configOptions": options,
	})
}

// acpConfigOptions 返回（必要时先建立）外部会话的配置项。
func (s *Controller) acpConfigOptions(ctx context.Context, name string) ([]acp.ConfigOption, error) {
	scoped, err := s.prepareACPWorkspace(&chatRequest{SessionName: name})
	if err != nil {
		return nil, err
	}
	s = scoped
	agentID := strOr(s.sessionMetaRead(name), "agentId", "")
	if !acp.IsExternal(agentID) {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	conn, err := s.acquireACP(ctx, name, agentID)
	if err != nil {
		return nil, err
	}
	return s.openACPSession(ctx, name, conn, false)
}

// setACPConfigOption 更新外部会话配置；旧版 Agent 的 mode/model
// 走 set_mode / set_model。
func (s *Controller) setACPConfigOption(ctx context.Context, name, id string, value any) ([]acp.ConfigOption, error) {
	scoped, err := s.prepareACPWorkspace(&chatRequest{SessionName: name})
	if err != nil {
		return nil, err
	}
	s = scoped
	agentID := strOr(s.sessionMetaRead(name), "agentId", "")
	if !acp.IsExternal(agentID) {
		return nil, fmt.Errorf("Agent 引擎不可用: %s", agentID)
	}
	conn, err := s.acquireACP(ctx, name, agentID)
	if err != nil {
		return nil, err
	}
	conn.Use()
	if _, err := s.openACPSession(ctx, name, conn, false); err != nil {
		return nil, err
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
		s.sessionMetaSet(name, map[string]any{"agentConfig": acp.MergedAgentConfig(s.sessionMetaRead(name), map[string]string{id: fmt.Sprint(value)})})
		conn.BindSession(conn.SessionID(), conn.Client().ConfigOptions())
		return conn.ConfigOptions(), nil
	}
	options, err := conn.SetConfigOption(ctx, id, value)
	if err != nil {
		return nil, err
	}
	s.sessionMetaSet(name, map[string]any{"agentConfig": acp.ConfigValues(options)})
	return options, nil
}

// applyAgentPreferences 在准备会话时套用该 Agent 的上次选择，返回生效后的配置。
// 标准 Agent 直接对刚打开的 conn 下发（sessionID 由绑定保证，不走全局 owner）；
// 只给 modes 的旧版 Agent 沿用逐项旧接口。
func (s *Controller) applyAgentPreferences(ctx context.Context, name, agentID string,
	conn *acp.Conn, options []acp.ConfigOption) []acp.ConfigOption {
	prefs := s.enginePreferencesRead()
	agents, _ := prefs["agents"].(map[string]any)
	values, _ := agents[agentID].(map[string]any)
	if len(values) == 0 || conn == nil {
		return options
	}
	if !conn.Client().ConfigOptionsSupported() {
		current := map[string]string{}
		for _, option := range options {
			current[option.ID] = fmt.Sprint(option.CurrentValue)
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
		return options
	}
	desired := map[string]string{}
	for id, value := range values {
		if id == "plan" {
			continue
		}
		desired[id] = fmt.Sprint(value)
	}
	options = acp.ApplyAgentConfig(ctx, conn, desired, options)
	conn.BindSession(conn.SessionID(), options)
	// 套用默认值不能抹掉已保存但本次不可用的选择：用合并语义写回，
	// Agent 收过的键用现值，被 Agent 拒绝/未列出的保存键留在 .meta 下次再试。
	s.sessionMetaSet(name, map[string]any{"agentConfig": acp.MergedAgentConfig(s.sessionMetaRead(name), acp.ConfigValues(options))})
	return options
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

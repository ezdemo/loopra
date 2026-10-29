package controller

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/acp"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

// agentEnginesDeepController 实现 /api/agent-engines 的深层
// 接口（契约 §3.3）。Go 运行时中只存在原生引擎：引擎选择返回
// native，配置选项则暴露审批链路所读取的
// 会话 hitl 模式。
func (s *Controller) agentEnginesDeepController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	switch {
	case strings.HasSuffix(r.URL.Path, "/mcp"):
		s.engineMcp(w, r)
	case strings.HasSuffix(r.URL.Path, "/preferences"):
		s.enginePreferences(w, r)
	case strings.HasSuffix(r.URL.Path, "/session"):
		s.engineSession(w, r)
	case strings.HasSuffix(r.URL.Path, "/prepare"):
		s.enginePrepare(w, r)
	case strings.HasSuffix(r.URL.Path, "/config"):
		s.engineConfig(w, r)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

// nativeConfigOptions 渲染用于 hitl 模式的 ACP 配置选项。
func (s *Controller) nativeConfigOptions(session string) []map[string]any {
	meta := s.sessionMetaRead(session)
	values, _ := meta["agentConfig"].(map[string]any)
	option := func(value, name, description string) map[string]any {
		return map[string]any{"value": value, "name": name, "description": description}
	}
	selectOption := func(id, name, category, current string, choices []map[string]any) map[string]any {
		return map[string]any{"id": id, "name": name, "description": "", "category": category, "type": "select", "currentValue": current, "options": choices}
	}
	out := []map[string]any{}
	models := []map[string]any{}
	for _, ch := range s.cfg.ModelChannels {
		for _, model := range ch.Models {
			label, description := model.DisplayName, ""
			if label == "" {
				label = model.Name
			} else if label != model.Name {
				description = model.Name
			}
			models = append(models, option(ch.ID+":"+model.Name, ch.Name+" / "+label, description))
		}
	}
	if len(models) > 0 {
		out = append(out, selectOption("model", "模型", "model", strOr(meta, "modelChannelId", s.cfg.ModelChannelID)+":"+strOr(meta, "model", s.cfg.Model), models))
	}
	current := hitl.NormalizeMode(strOr(values, "mode", strOr(meta, "hitl", s.cfg.Hitl)))
	out = append(out, selectOption("mode", "权限模式", "mode", current, []map[string]any{
		option("approval", "按需审批", "需要授权的工具操作由用户审批"),
		option("auto", "自动审批", "使用 Loopra 的自动审批策略"),
		option("free", "完全自动", "不进行工具权限审批"),
	}))
	efforts := []map[string]any{}
	for _, value := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"} {
		efforts = append(efforts, option(value, value, ""))
	}
	out = append(out, selectOption("effort", "思考强度", "thought_level", strOr(meta, "reasoningEffort", s.cfg.ReasoningEffort), efforts))
	fast, plan := "off", "off"
	if s.cfg.FastMode {
		fast = "on"
	}
	if meta["planMode"] == true {
		plan = "on"
	}
	toggles := []map[string]any{option("off", "关闭", ""), option("on", "开启", "")}
	out = append(out, selectOption("fast", "快速模式", "model_config", strOr(values, "fast", fast), toggles))
	if s.agent.App() != chatWorkspace {
		out = append(out, selectOption("plan", "计划模式", "_plan", plan, toggles))
	}
	return out
}

func (s *Controller) setNativeConfigOption(name, id string, value any) error {
	valid := false
	for _, option := range s.nativeConfigOptions(name) {
		if option["id"] == id {
			for _, choice := range option["options"].([]map[string]any) {
				if choice["value"] == value {
					valid = true
				}
			}
		}
	}
	if !valid {
		return fmt.Errorf("无效的 Agent 配置值")
	}
	text := value.(string)
	patch := map[string]any{}
	switch id {
	case "model":
		for _, ch := range s.cfg.ModelChannels {
			for _, model := range ch.Models {
				if ch.ID+":"+model.Name == text {
					patch["model"], patch["modelChannelId"] = model.Name, ch.ID
				}
			}
		}
	case "effort":
		patch["reasoningEffort"] = text
	case "plan":
		patch["planMode"] = text == "on"
		if text == "off" {
			patch["pendingPlan"] = ""
		}
	default:
		values, _ := s.sessionMetaRead(name)["agentConfig"].(map[string]any)
		if values == nil {
			values = map[string]any{}
		}
		values[id] = text
		patch["agentConfig"] = values
		if id == "mode" {
			patch["hitl"] = text
		}
	}
	s.sessionMetaSet(name, patch)
	return nil
}

// engineMcp 响应引擎级 MCP 开关：来自共享配置的已配置服务，
// 以及存在时的项目级 .loopra/mcp.json。
func (s *Controller) engineMcp(w http.ResponseWriter, r *http.Request) {
	s.engineMcpSettings(w, r)
}

// enginePreferences 将每个安装所选的引擎存储在附属
// JSON 文件中（Go 运行时中仅 "native" 可选）。
func (s *Controller) enginePreferencesPath() string {
	return filepath.Join(s.home, "agent-preferences.json")
}

func (s *Controller) enginePreferencesRead() map[string]any {
	out := map[string]any{"agents": map[string]any{}}
	if data, err := os.ReadFile(s.enginePreferencesPath()); err == nil {
		_ = json.Unmarshal(data, &out)
	}
	if out["agents"] == nil {
		out["agents"] = map[string]any{}
	}
	if out["selectedAgent"] == "looprax" {
		out["selectedAgent"] = "native"
	}
	return out
}

func (s *Controller) enginePreferences(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeOK(w, http.StatusOK, s.enginePreferencesRead())
	case http.MethodPut:
		var body struct {
			SelectedAgent string `json:"selectedAgent"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.SelectedAgent) == "" {
			writeFail(w, http.StatusBadRequest, "selectedAgent 必填")
			return
		}
		if body.SelectedAgent == "looprax" {
			body.SelectedAgent = "native"
		}
		if body.SelectedAgent != "native" && !acp.IsExternal(body.SelectedAgent) {
			writeFail(w, http.StatusBadRequest, "Agent 引擎不可用: "+body.SelectedAgent)
			return
		}
		s.state.files.Lock()
		defer s.state.files.Unlock()
		prefs := s.enginePreferencesRead()
		prefs["selectedAgent"] = body.SelectedAgent
		if err := repository.WriteJSON(s.enginePreferencesPath(), prefs); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, prefs)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

// engineSession 返回驱动某个会话的引擎。
func (s *Controller) engineSession(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("sessionName")
	if name == "" {
		writeFail(w, http.StatusBadRequest, "sessionName 必填")
		return
	}
	agentID := s.migrateRetiredAgent(name)
	if agentID == "" {
		agentID = "native"
	}
	writeOK(w, http.StatusOK, map[string]any{
		"agentId":     agentID,
		"hasMessages": len(s.sessionMessages(r.Context(), name)) > 0,
	})
}

// enginePrepare 解析引擎运行应当指向的会话；名称为空时会生成新的
// loopra-<uuid> 会话。与 Java 一致，这里只固定设置与当前会话，不创建
// 会话日志——空白会话在首条消息写入前不落盘。
func (s *Controller) enginePrepare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceHash string `json:"workspaceHash"`
		SessionName   string `json:"sessionName"`
		AgentID       string `json:"agentId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.AgentID == "looprax" {
		body.AgentID = "native"
	}
	if body.AgentID != "" && body.AgentID != "native" && !acp.IsExternal(body.AgentID) {
		writeFail(w, http.StatusBadRequest, "Agent 引擎不可用: "+body.AgentID)
		return
	}
	name := strings.TrimSpace(body.SessionName)
	if name == "" && s.acp != nil && body.AgentID != "" && body.AgentID != "native" && acp.IsExternal(body.AgentID) {
		for _, candidate := range s.acp.IdleSessions(s.acpHost(), body.AgentID, s.workspaceRoot()) {
			if len(s.sessionMessages(r.Context(), candidate)) == 0 {
				logging.Debugf("acp", "reuse idle draft session=%s agent=%s", candidate, body.AgentID)
				name = candidate
				break
			}
		}
	}
	if name == "" {
		name = "loopra-" + newUUIDv4()
	}
	if body.AgentID != "" && body.AgentID != "native" {
		s.prepareExternalEngine(w, r, name, body.AgentID)
		return
	}
	_, existing := s.agent.Sessions.Get(r.Context(), getSessionRequest(s.agent, name))
	if _, err := s.resolveSessionSettings(name, nil); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	s.sessionMetaSet(name, map[string]any{"agentId": "native"})
	if existing != nil {
		prefs := s.enginePreferencesRead()
		agents, _ := prefs["agents"].(map[string]any)
		values, _ := agents["native"].(map[string]any)
		for _, id := range []string{"model", "effort", "mode", "fast"} {
			if value, ok := values[id]; ok {
				_ = s.setNativeConfigOption(name, id, value)
			}
		}
	}
	writeOK(w, http.StatusOK, map[string]any{
		"sessionName": name, "agentId": "native",
		"configOptions": s.nativeConfigOptions(name),
	})
}

// engineConfig 读取或更新某个会话的引擎配置；原生
// 引擎暴露 hitl 的 "mode" 选项。
func (s *Controller) engineConfig(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("sessionName")
	if r.Method == http.MethodPut {
		var body struct {
			WorkspaceHash string `json:"workspaceHash"`
			SessionName   string `json:"sessionName"`
			ConfigID      string `json:"configId"`
			Value         any    `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionName == "" ||
			body.ConfigID == "" {
			writeFail(w, http.StatusBadRequest, "请求参数不完整")
			return
		}
		agentID := s.migrateRetiredAgent(body.SessionName)
		if agentID == "" {
			agentID = "native"
		}
		if acp.IsExternal(agentID) {
			// 运行中允许直接作用于活动 ACP 客户端（Java AgentService）。
			options, err := s.setACPConfigOption(r.Context(), body.SessionName, body.ConfigID, body.Value)
			if err != nil {
				writeFail(w, http.StatusBadRequest, err.Error())
				return
			}
			s.persistAgentPreferences(body.SessionName, agentID)
			writeOK(w, http.StatusOK, map[string]any{"configOptions": options})
			return
		}
		if s.sessionRunning(body.SessionName) != "" {
			writeFail(w, http.StatusConflict, "请等待当前回复结束后再修改 Native 配置")
			return
		}
		if err := s.setNativeConfigOption(body.SessionName, body.ConfigID, body.Value); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		if body.ConfigID != "plan" {
			s.state.files.Lock()
			prefs := s.enginePreferencesRead()
			agents, _ := prefs["agents"].(map[string]any)
			values := map[string]any{}
			for _, option := range s.nativeConfigOptions(body.SessionName) {
				if option["id"] != "plan" {
					values[option["id"].(string)] = option["currentValue"]
				}
			}
			agents["native"] = values
			err := repository.WriteJSON(s.enginePreferencesPath(), prefs)
			s.state.files.Unlock()
			if err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		writeOK(w, http.StatusOK, map[string]any{
			"configOptions": s.nativeConfigOptions(body.SessionName),
		})
		return
	}
	if name == "" {
		writeFail(w, http.StatusBadRequest, "sessionName 必填")
		return
	}
	if acp.IsExternal(s.migrateRetiredAgent(name)) {
		options, err := s.acpConfigOptions(r.Context(), name)
		if err != nil {
			writeFail(w, http.StatusServiceUnavailable, acp.TranslateFailure(err).Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"configOptions": options})
		return
	}
	writeOK(w, http.StatusOK, map[string]any{"configOptions": s.nativeConfigOptions(name)})
}

// newUUIDv4 返回用于引擎创建的会话名的随机 UUID。
func newUUIDv4() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", os.Getpid())
	}
	buf[6] = buf[6]&0x0f | 0x40
	buf[8] = buf[8]&0x3f | 0x80
	h := hex.EncodeToString(buf)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

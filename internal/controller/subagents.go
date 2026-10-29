package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SubAgentProfile 对应 SubAgentProfileConfig（~/.loopra/sub-agents.json）。
type SubAgentProfile struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Enable       *bool    `json:"enable,omitempty"` // nil 表示 true
	ReadOnly     bool     `json:"readOnly"`
	Instructions string   `json:"instructions,omitempty"`
	AllowedTools []string `json:"allowedTools,omitempty"`
	ModelChannel string   `json:"modelChannel,omitempty"`
	Model        string   `json:"model,omitempty"`
}

// builtinProfiles 复现 Java 枚举的内容；内置 id 的自定义字段
// 在每次进程启动时被强制还原（仅 enable 得以保留），
// 与 SubAgentProfileStore.mergeBuiltins 保持一致。
func builtinProfiles() []SubAgentProfile {
	yes := true
	return []SubAgentProfile{
		{ID: "explore", Name: "探索", ReadOnly: true, Enable: &yes,
			Description: "定位代码、追溯调用链并基于证据汇报",
			Instructions: "你只做调查，不修改任何文件。先定位相关文件与调用链，再下结论。" +
				"汇报时按「发现 / 证据（文件与位置）/ 建议」组织，不确定的地方必须明确说明。"},
		{ID: "implement", Name: "实现", ReadOnly: false, Enable: &yes,
			Description: "按指定范围实现功能或修复并执行相关检查",
			Instructions: "先阅读相关代码与约束，在最小范围内完成实现。" +
				"修改后运行相关检查或测试验证。按「修改 / 验证 / 剩余风险」汇报。"},
		{ID: "test", Name: "测试", ReadOnly: false, Enable: &yes,
			Description: "确认覆盖缺口并添加或调整必要测试",
			Instructions: "先确认现有行为与测试覆盖缺口，再补充必要的测试。" +
				"除非明确要求，不修改生产代码。按「覆盖场景 / 测试结果 / 发现的问题」汇报。"},
		{ID: "review", Name: "审查", ReadOnly: true, Enable: &yes,
			Description: "寻找缺陷、回归、安全问题与测试缺口",
			Instructions: "只做只读审查。优先报告真实缺陷、回归、并发问题、安全隐患与测试缺口，" +
				"按严重性排序，每项附文件位置、影响与修复方向。"},
		{ID: "plan", Name: "方案", ReadOnly: true, Enable: &yes,
			Description: "理解现状并给出可执行的分步方案",
			Instructions: "只调查与设计，不修改文件。理解现有实现与约束后，给出可执行的分步方案，" +
				"包含涉及模块、兼容性、验证方法与取舍。"},
	}
}

// subAgentDeniedTools 是应用于每个子代理的硬性拒绝列表
// （SubAgent.SUB_AGENT_DENY，已排序）。
var subAgentDeniedTools = []string{
	"ask_choice", "checklist_start", "checklist_status", "checklist_step",
	"goal_block", "goal_complete", "goal_create", "goal_resume",
	"goal_status", "goal_update_step", "submit_plan", "sub_agent",
}

// subAgentConfigFile 是 ~/.loopra/sub-agents.json 中的 {profiles: [...]}。
type subAgentConfigFile struct {
	Profiles []SubAgentProfile `json:"profiles"`
}

func (s *Controller) subAgentsPath() string {
	return filepath.Join(s.home, "sub-agents.json")
}

// subAgentLoad 读取配置文件，缺失时创建默认内容，
// 并在每进程首次访问时还原内置内容。
func (s *Controller) subAgentLoad() []SubAgentProfile {
	var file subAgentConfigFile
	data, err := os.ReadFile(s.subAgentsPath())
	if err == nil {
		_ = json.Unmarshal(data, &file)
	}
	byID := map[string]int{}
	for i, p := range file.Profiles {
		byID[strings.ToLower(strings.TrimSpace(p.ID))] = i
	}
	merged := false
	for _, builtin := range builtinProfiles() {
		if i, ok := byID[builtin.ID]; ok {
			enable := file.Profiles[i].Enable // 仅 enable 得以保留
			builtin.Enable = enable
			file.Profiles[i] = builtin
		} else {
			file.Profiles = append(file.Profiles, builtin)
			merged = true
		}
	}
	if err != nil || merged {
		s.subAgentSave(file.Profiles)
	}
	return file.Profiles
}

func (s *Controller) subAgentSave(profiles []SubAgentProfile) {
	data, _ := json.MarshalIndent(subAgentConfigFile{Profiles: profiles}, "", "  ")
	_ = os.WriteFile(s.subAgentsPath(), data, 0o644)
}

// subAgentDTO 构造 SubAgentInfoDTO；tools 列出已启用的注册表
// 工具（角色为只读时按只读过滤）。
func (s *Controller) subAgentDTO(p SubAgentProfile) map[string]any {
	enabled := true
	if p.Enable != nil {
		enabled = *p.Enable
	}
	var toolNames []string
	if s.registry != nil {
		for _, t := range s.registry.List() {
			if p.ReadOnly && !t["readOnly"].(bool) {
				continue
			}
			if name, _ := t["name"].(string); name != "" {
				toolNames = append(toolNames, name)
			}
		}
		sort.Strings(toolNames)
	}
	if toolNames == nil {
		toolNames = []string{}
	}
	dto := map[string]any{
		"id": p.ID, "name": p.Name, "description": p.Description,
		"readOnly": p.ReadOnly, "systemPrompt": p.Instructions,
		"tools": toolNames, "enable": enabled,
		"builtin": isBuiltinProfile(p.ID),
	}
	if len(p.AllowedTools) > 0 {
		dto["allowedTools"] = p.AllowedTools
	}
	if p.ModelChannel != "" {
		dto["modelChannel"] = p.ModelChannel
	}
	if p.Model != "" {
		dto["model"] = p.Model
	}
	return dto
}

func isBuiltinProfile(id string) bool {
	switch strings.ToLower(id) {
	case "explore", "implement", "test", "review", "plan":
		return true
	}
	return false
}

// subAgentsController 实现 GET/PUT /api/sub-agents 和
// GET /api/sub-agents/denied-tools。
func (s *Controller) subAgentsController(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/denied-tools") {
		writeOK(w, http.StatusOK, subAgentDeniedTools)
		return
	}
	switch r.Method {
	case http.MethodGet:
		profiles := s.subAgentLoad()
		out := make([]map[string]any, 0, len(profiles))
		for _, p := range profiles {
			out = append(out, s.subAgentDTO(p))
		}
		writeOK(w, http.StatusOK, out)
	case http.MethodPut:
		var body subAgentConfigFile
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeFail(w, http.StatusBadRequest, "配置格式不正确")
			return
		}
		seen := map[string]bool{}
		for i := range body.Profiles {
			p := &body.Profiles[i]
			p.ID = strings.ToLower(strings.TrimSpace(p.ID))
			if p.ID == "" {
				writeFail(w, http.StatusBadRequest, "子代理 ID 不能为空")
				return
			}
			if seen[p.ID] {
				writeFail(w, http.StatusBadRequest, "子代理 ID 重复: "+p.ID)
				return
			}
			seen[p.ID] = true
			if len(p.AllowedTools) == 0 {
				p.AllowedTools = nil
			}
			// 内置内容字段会在下次加载时被强制还原
		}
		s.subAgentSave(body.Profiles)
		profiles := s.subAgentLoad()
		out := make([]map[string]any, 0, len(profiles))
		for _, p := range profiles {
			out = append(out, s.subAgentDTO(p))
		}
		writeOK(w, http.StatusOK, out)
	}
}

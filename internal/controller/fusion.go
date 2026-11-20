package controller

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
)

// fusionSidekickOption 是会话级 Fusion 开关在 .meta 与引擎配置中的键；
// 取值是 "off" 或 "<channelId>:<modelName>" 的组合目录项。
const fusionSidekickOption = "fusionSidekick"

// fusionEffortOption 是 Fusion 执行模型独立的推理强度键；取值是
// "default" 或推理强度目录项，只作用于 fusion_delegate。
const fusionEffortOption = "fusionSidekickEffort"
const fusionDefaultEffort = "default"

const fusionOff = "off"

func isFusionConfigOption(id string) bool {
	return id == fusionSidekickOption || id == fusionEffortOption
}

// fusionEpochKey 是执行上下文的代号：选择变更、关闭再开启或历史撤回
// 都会轮换它，旧检查点随作用域指纹失效而不会误续到新的上下文。
const fusionEpochKey = "fusionSidekickEpoch"

const fusionLeadInstruction = `Fusion 模式已启用。你是主代理，负责澄清需求、定方向和验收标准、权衡方案、审查结果及与用户沟通。凡是需要用项目工具完成的调查或工作，默认交给 Sidekick，不要先自行把同样的活做一遍。
需要了解项目现状、查代码、找根因或回答依赖代码的问题时，先用 checklist_update 列出实际步骤，第一项安排 Sidekick 调查；用 fusion_delegate 的 explore 角色交接，说明要查的问题、范围以及需要返回的文件位置、调用链、证据和不确定点。可以委派事实调查和选项比较，不把最终设计决策交出去。若现有证据或用户给定的方案已足够，不强制增加探索步骤；不依赖项目工具的简单问答直接回答，不为形式列计划或委派。
收到调查结果后，由你判断证据是否充分并选定方案。明确范围、约束和验收条件后，把修改和相关测试交给同一个 Sidekick（implement）；仅需专项验证时用 test。后续修正也交回同一个 Sidekick，不必重复已有上下文。你要针对关键证据、实际改动与验证结果做独立抽查，而不是重做调查或测试。仅在 Sidekick 缺少能力、交接失败无法继续，或必须由你进行独立核验时亲自用工具；需要接手时说明原因。
每次交接前先用 checklist_update 把本次 Sidekick 步骤标为 active，等待更新成功，再单独调用 fusion_delegate；每次只同步交接一步，不用 sub_agent 或 tool_result 代替。按实际结果推进清单，失败不标完成；交付前更新清单并说明实际结果。`

const fusionWorkerInstruction = `你是此会话的 Fusion 执行模型。只执行最新交接，之前的任务和工具结果仅供参考，不重复已完成的工作。explore 只调查，返回结论、文件位置或调用链、可核对的证据和不确定点；implement 和 test 按本次范围与验收条件执行，回报实际改动、实际运行的检查和剩余问题。遵守当前角色、工作区指引与工具审批，不擅自扩大范围或改变方案，不提交或发布。`

// fusionModel 把 "channel:model" 目录值解析回渠道与模型名；
// 不拆分字符串，避免渠道 id 或模型名本身含冒号。
func fusionModel(cfg *config.Loopra, value string) (config.Channel, string, bool) {
	for _, ch := range cfg.ModelChannels {
		for _, entry := range ch.Models {
			if ch.ID+":"+entry.Name == value {
				return ch, entry.Name, true
			}
		}
	}
	return config.Channel{}, "", false
}

// fusionSettings 只为尚未使用的会话补充服务端的 Fusion 默认值。
func (s *Controller) fusionSettings(meta map[string]any, fresh bool) (model, effort string) {
	model, effort = strOr(meta, fusionSidekickOption, ""), strOr(meta, fusionEffortOption, "")
	var defaults map[string]any
	if fresh && (model == "" || effort == "") {
		_, defaults = nativeEnginePreferences(s.enginePreferencesRead())
	}
	if model == "" {
		model = strOr(defaults, fusionSidekickOption, fusionOff)
	}
	if effort == "" {
		effort = strOr(defaults, fusionEffortOption, fusionDefaultEffort)
	}
	return
}

type fusionTurnSettings struct {
	model, effort, epoch string
	channel              config.Channel
}

// setFusionConfigOption 保存会话的明确选择及新会话的默认值。
// 模型变化时轮换 epoch；重选相同值或调整推理强度保留上下文。
func (s *Controller) setFusionConfigOption(name, id, value string) error {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	prefs, err := s.loadEnginePreferences()
	if err != nil {
		return fmt.Errorf("读取 Agent 偏好失败: %w", err)
	}
	agents, values := nativeEnginePreferences(prefs)
	// 保存旧的 native 配置以便会话写入失败时回退。
	previous, existed := agents["native"]
	next := maps.Clone(values)
	next[id] = value
	agents["native"] = next
	if err := repository.WriteJSON(s.enginePreferencesPath(), prefs); err != nil {
		return fmt.Errorf("保存 Agent 偏好失败: %w", err)
	}
	meta := s.sessionMetaRead(name)
	if meta == nil {
		meta = map[string]any{}
	}
	if id == fusionSidekickOption && strOr(meta, fusionSidekickOption, fusionOff) != value {
		meta[fusionEpochKey] = newUUIDv4()
	}
	meta[id] = value
	if err := s.sessionMetaWrite(name, meta); err != nil {
		if existed {
			agents["native"] = previous
		} else {
			delete(agents, "native")
		}
		if restoreErr := repository.WriteJSON(s.enginePreferencesPath(), prefs); restoreErr != nil {
			err = errors.Join(err, fmt.Errorf("恢复 Agent 偏好失败: %w", restoreErr))
		}
		return fmt.Errorf("保存会话 Fusion 配置失败: %w", err)
	}
	return nil
}

// fusionTurnSelection 固定草稿继承的值，避免已开始的会话跟随默认值变化。
func (s *Controller) fusionTurnSelection(name string, cfg *config.Loopra) (fusionTurnSettings, error) {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	meta := s.sessionMetaRead(name)
	if meta == nil {
		meta = map[string]any{}
	}
	fresh := !s.sessionPersisted(name)
	var settings fusionTurnSettings
	settings.model, settings.effort = s.fusionSettings(meta, fresh)
	if settings.model != fusionOff {
		var ok bool
		settings.channel, _, ok = fusionModel(cfg, settings.model)
		if !ok {
			return fusionTurnSettings{}, fmt.Errorf("Fusion 执行模型已不可用，请重新选择或关闭 Fusion")
		}
	}
	changed := false
	if fresh {
		for id, value := range map[string]string{fusionSidekickOption: settings.model, fusionEffortOption: settings.effort} {
			if strOr(meta, id, "") == "" {
				meta[id] = value
				changed = true
			}
		}
	}
	if changed {
		if err := s.sessionMetaWrite(name, meta); err != nil {
			return fusionTurnSettings{}, fmt.Errorf("保存会话 Fusion 配置失败: %w", err)
		}
	}
	if settings.model == fusionOff {
		settings.model = ""
	}
	if settings.effort == fusionDefaultEffort {
		settings.effort = ""
	}
	settings.epoch = strOr(meta, fusionEpochKey, "")
	return settings, nil
}

// resetFusionContext 在父会话历史被撤回后轮换 Fusion 上下文代号：
// 撤掉的历史不应再被下一次委派续用。Fusion 未开启时无事可做。
func (s *Controller) resetFusionContext(name string) error {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	meta := s.sessionMetaRead(name)
	if selection := strOr(meta, fusionSidekickOption, fusionOff); selection == fusionOff {
		return nil
	}
	meta[fusionEpochKey] = newUUIDv4()
	return s.sessionMetaWrite(name, meta)
}

// fusionScope 计算执行上下文的作用域指纹：应用、父会话、所选模型、
// epoch、运行时工作区与渠道端点任一变化都得到新指纹，新指纹对应
// 全新上下文。不包含 API 密钥等凭据。
func (s *Controller) fusionScope(parent, selection, epoch string, channel config.Channel, roots []string) string {
	roots = append([]string(nil), roots...)
	sort.Strings(roots)
	fields := []string{s.agent.App(), parent, selection, epoch,
		filepath.Clean(s.workspaceRoot()), channel.BaseURL, channel.APIProtocol, channel.SpecialCompatibility}
	fields = append(fields, roots...)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(strings.Join(fields, "\x00"))))
}

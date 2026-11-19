package controller

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ezdemo/looprax/internal/model/config"
)

// fusionSidekickOption 是会话级 Fusion 开关在 .meta 与引擎配置中的键；
// 取值是 "off" 或 "<channelId>:<modelName>" 的组合目录项。
const fusionSidekickOption = "fusionSidekick"
const fusionOff = "off"

// fusionEpochKey 是执行上下文的代号：选择变更、关闭再开启或历史撤回
// 都会轮换它，旧检查点随作用域指纹失效而不会误续到新的上下文。
const fusionEpochKey = "fusionSidekickEpoch"

const fusionLeadInstruction = `Fusion 模式已启用。你是主代理，负责理解需求、定位根因、拆解任务和审查结果。对实现、修复、重构和需要实际运行的验证，先用 checklist_update 列出本轮可检查的步骤和负责人，再执行。计划必须针对实际任务拆分，不要套用空泛模板：主代理（lead）负责侦察、决策和审查，Sidekick（sidekick）默认负责明确的改动、跑测试和构建。直接的单步操作可以只列一项；只问解释、查事实或闲聊时直接回答，不要为了形式列计划或委派。每次用 checklist_update 把一个 Sidekick 步骤标为 active，等待计划工具成功返回后，再单独调用 fusion_delegate 同步交接这一步，给出任务范围、约束和验收条件。不要用 sub_agent 或 tool_result 代替 Fusion 交接。收到结果后亲自检查，再用 checklist_update 更新整份清单并推进下一步；失败不标完成，发现问题可安排新的修正步骤并交回同一个 Sidekick，不用重发历史。需要自己接手时说明原因。不要委派未解决的设计决策，也不要同时发起多个 Fusion 委派。最后同步实际完成状态，再向用户交付。`

const fusionWorkerInstruction = `你是此会话的 Fusion 执行模型。每次交接只执行最新任务，之前交接仅供参考。按本次角色约定、范围和验收条件工作；遵守工作区指引与工具审批，不要替主代理改变方案，不要提交或发布。回报实际改动、实际运行的检查及剩余问题。`

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

// setFusionSidekick 更新会话的 Fusion 选择；"off" 直接移除键，
// 不写入引擎级 preferences（这是按会话的开关，不是全局默认）。
// 选择变化时轮换 epoch；重选相同值保留上下文。
func (s *Controller) setFusionSidekick(name, value string) error {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	meta := s.sessionMetaRead(name)
	if previous := strOr(meta, fusionSidekickOption, fusionOff); previous != value {
		meta[fusionEpochKey] = newUUIDv4()
	}
	if value == fusionOff {
		delete(meta, fusionSidekickOption)
	} else {
		meta[fusionSidekickOption] = value
	}
	return s.sessionMetaWrite(name, meta)
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

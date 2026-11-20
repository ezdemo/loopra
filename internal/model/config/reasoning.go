package config

import "slices"

// builtinReasoningEfforts 是未配置模型沿用的内置推理强度目录。
var builtinReasoningEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// ReasoningEffortChoices 返回可选强度：已配置列表原样使用（含显式
// 空列表），未配置时回退内置目录。
func ReasoningEffortChoices(levels []string) []string {
	if levels != nil {
		return levels
	}
	return builtinReasoningEfforts
}

// ResolveReasoningEffort 归一推理强度：未配置列表时偏好值原样透传、
// 缺省回退全局值；已配置时依次取受支持的偏好值、全局值与目录首项，
// 显式空目录返回 ""。
func ResolveReasoningEffort(levels []string, preferred, fallback string) string {
	if levels == nil {
		if preferred != "" {
			return preferred
		}
		return fallback
	}
	if slices.Contains(levels, preferred) {
		return preferred
	}
	if slices.Contains(levels, fallback) {
		return fallback
	}
	if len(levels) > 0 {
		return levels[0]
	}
	return ""
}

// ReasoningEffortsFor 返回渠道内指定模型配置的推理强度目录。模型名
// 为空时取渠道首个条目（与 provider 的能力回退一致）；命名模型不存在
// 时不借用其他条目的配置。
func (c *Loopra) ReasoningEffortsFor(channelID, modelName string) []string {
	channel, ok := c.ChannelByID(channelID)
	if !ok {
		return nil
	}
	for _, entry := range channel.Models {
		if entry.Name == modelName {
			return entry.ReasoningEfforts
		}
	}
	if modelName == "" && len(channel.Models) > 0 {
		return channel.Models[0].ReasoningEfforts
	}
	return nil
}

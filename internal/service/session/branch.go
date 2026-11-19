package session

// ConvertedBranchMeta 为跨引擎分支生成新会话的 .meta：保留未列出的键
// （连接器开关、自定义扩展等），剥离源引擎的执行状态、模型选择、
// 角色绑定与历史注入标记。外部目标需要在自己第一条提示词里补种
// 历史，acpHistorySeed 只表达这个意图，不含已注入的远端 id。
func ConvertedBranchMeta(source map[string]any, targetID, title string) map[string]any {
	meta := make(map[string]any, len(source))
	for key, value := range source {
		meta[key] = value
	}
	for _, key := range []string{"agentId", "title", "model", "modelChannelId", "reasoningEffort", "customAgentId", "agentConfig", "hitl", "fusionSidekick", "fusionSidekickEpoch", "acpSessionId", "acpCwd", "acpUsage", "acpPlan", "acpCommands", "acpHistorySeed", "acpHistorySeededSessionId"} {
		delete(meta, key)
	}
	meta["agentId"], meta["title"], meta["worktreeMode"] = targetID, title, false
	if targetID != "native" {
		meta["acpHistorySeed"] = true
	}
	return meta
}

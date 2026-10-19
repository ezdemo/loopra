// Prompt offered when the Claude Code ACP runtime is missing. The versions and
// commands mirror ClaudeAcpProcess's launch requirements (see docs/acp-claude.md).
export function claudeAcpInstallPrompt(): string {
  return [
    '请帮我安装 Claude Code 的 ACP 依赖：',
    '1. 检查 Node.js 22+ 是否已安装，未安装则安装',
    '2. 检查 Claude Code 是否已安装，未安装则安装',
    '3. 检查 ACP 适配器 @agentclientprotocol/claude-agent-acp 是否已安装，未安装则安装最新版',
    '完成后告诉我结果。',
  ].join('\n');
}

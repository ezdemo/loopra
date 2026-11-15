// Prompts match the dependencies detected by each backend provider.
export function claudeAcpInstallPrompt(): string {
  return [
    '请帮我安装 Claude Code 的 ACP 依赖：',
    '1. 检查 Node.js 22+ 是否已安装，未安装则安装',
    '2. 检查 Claude Code 是否已安装，未安装则安装',
    '3. 检查 ACP 适配器 @agentclientprotocol/claude-agent-acp 是否已安装，未安装则安装最新版',
    '完成后告诉我结果。',
  ].join('\n');
}

export function agentAcpInstallPrompt(agentId: string): string {
  if (agentId === 'claude-code') return claudeAcpInstallPrompt();
  if (agentId === 'devin') return [
    '请帮我安装 Devin 的 ACP 依赖：',
    '1. 安装 Devin CLI：curl -fsSL https://cli.devin.ai/install.sh | bash（或直接安装 Devin Desktop）',
    '2. 确认 devin 命令可用；不在 PATH 时可用 LOOPRA_DEVIN_EXECUTABLE 指定路径',
    '3. 运行 devin auth login 完成登录，ACP 直接使用本机凭据',
    '完成后告诉我结果。',
  ].join('\n');
  if (agentId !== 'codex') return '';
  return [
    '请帮我安装 Codex 的 ACP 依赖：',
    '1. 检查 Node.js 22+ 是否已安装，未安装则安装',
    '2. 检查 ACP 适配器 @agentclientprotocol/codex-acp 是否已安装，未安装则安装最新版',
    '3. 适配器自带兼容的 Codex CLI，使用本机已有的 Codex 登录和配置；检查登录状态，需要登录时告诉我操作方式',
    '完成后告诉我结果。',
  ].join('\n');
}

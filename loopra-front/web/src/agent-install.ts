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
  if (agentId === 'pi') return [
    '请帮我安装 Pi 的 ACP 依赖：',
    '1. 检查 Node.js 22+ 是否已安装，未安装则安装',
    '2. 安装 Pi CLI 和 ACP 适配器：npm install -g @earendil-works/pi-coding-agent pi-acp',
    '3. 检查 pi 与 pi-acp 命令可用，使用本机 Pi 配置；需要登录或配置模型时告诉我操作方式',
    '4. pi-acp 当前不转发工作台 MCP，请在 Pi 中单独配置所需扩展',
    '完成后告诉我结果。',
  ].join('\n');
  if (agentId === 'dsh') return [
    '请帮我安装 DeepSeek Harness 的 ACP 依赖：',
    '1. 按 DSH 版本要求安装 Node.js（当前源码要求 24.9+）',
    '2. 检查 @deepseek-ai/dsh，安装提供 ACP profile 的版本；若 npm 版本尚未提供，请按官方说明构建源码',
    '3. 验证 dsh --profile acp --help 可用；源码构建可用 LOOPRA_DSH_ACP_SCRIPT 指定构建后的 CLI JS 入口',
    '4. 使用本机 DSH 配置，需要配置模型或凭据时告诉我操作方式',
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

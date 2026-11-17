// Prompts stay minimal on purpose: the receiving Agent knows how to detect and
// install its own ACP dependencies better than a checklist we would have to
// keep in sync with each provider's packaging.
const acpAgentNames: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  devin: 'Devin CLI',
};

export function agentAcpInstallPrompt(agentId: string): string {
  const name = acpAgentNames[agentId];
  return name ? `帮我安装好 ${name} 和它的 ACP 适配器，让三方应用能通过 ACP 协议驱动它。安装完成即可，接口调用、登录校验、ACP 客户端配置让用户自行完成。` : '';
}

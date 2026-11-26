export const settingsCategories = [
  { name: '偏好设置', key: 'preferences', sections: [
    { name: '通用', key: 'general', label: '通用', keywords: '外观 主题 字体 语言 通知 动画 实验室 appearance theme font language notifications animation general' },
    { name: '宠物', key: 'pet', label: '宠物', keywords: '宠物 pet 伴侣 画廊 选择 大小 位置 初始化 companion gallery size position' },
  ] },
  { name: '模型服务', key: 'models', sections: [
    { name: '模型供应商', key: 'providers', label: '模型供应商', keywords: '模型渠道 API 密钥 上下文 价格 model providers channels api key context price' },
    { name: '模型用途', key: 'modelUsage', label: '模型用途', keywords: '默认模型 新会话 当前聊天 命令校验 图片理解 模型分配 default model usage chat command validation image' },
  ] },
  { name: '智能体', key: 'agents', sections: [
    { name: '智能体与会话', key: 'agentSessions', label: '会话默认', keywords: '权限 推理 计划 快速 session defaults permission reasoning plan fast' },
    { name: '系统提示词', key: 'systemPrompt', label: '系统提示词', keywords: 'prompt loopra.md system prompt' },
    { name: '记忆', key: 'memory', label: '记忆', keywords: '全局 项目 个人偏好 系统环境 Java Node nvm memory 长期 跨会话 global project preference environment long-term' },
    { name: '子代理', key: 'subagents', label: '子代理', keywords: '角色 提示词 白名单 subagent sub-agent role prompt allowlist' },
    { name: '外部 Agent', key: 'externalAgents', label: '外部 Agent', keywords: 'ACP Claude Code Codex Devin 第三方 外部 安装 选择器 external install selector' },
  ] },
  { name: '工具与集成', key: 'tools', sections: [
    { name: '工具', key: 'tools', label: '工具', keywords: 'tools 只读 写入 read-only write' },
    { name: 'MCP', key: 'mcp', label: 'MCP', keywords: '外部 服务 连接 stdio SSE 工具权限 传输 external service connection tool permission transport' },
    { name: 'MCP 服务器', key: 'mcpServer', label: 'MCP 服务器', keywords: '工具 发布 导出 MCP Server Cloudflare 隧道 连接地址 publish export tunnel connection address' },
  ] },
  { name: '工作区与数据', key: 'workspace', sections: [
    { name: '项目', key: 'projects', label: '工作区', keywords: '路径 工作区 目录 workspace project path directory' },
    { name: '数据面板', key: 'usage', label: '用量', keywords: '统计 token 用量 费用 usage statistics cost' },
  ] },
  { name: '连接与帮助', key: 'connection', sections: [
    { name: '服务器', key: 'server', label: '服务连接', keywords: '后端 API 连接 server service backend connection' },
    { name: '远程访问', key: 'remoteAccess', label: '远程访问', keywords: '手机 安卓 iOS Loopra Mobile 中继 relay 注册密钥 配对 链接 二维码 remote access phone pairing qrcode' },
    { name: '网络代理', key: 'proxy', label: '网络代理', keywords: '代理 proxy http socks 出站 网络 network outbound' },
    { name: '快捷键', key: 'shortcuts', label: '快捷键', keywords: '键盘 输入 shortcuts keyboard input' },
    { name: '关于', key: 'about', label: '关于与存储', keywords: '本地 账户 数据存储 版本 about storage local account version' },
  ] },
];

export function normalizeSettingsSection(name: string): string {
  if (name === 'OpenAPI' || name === '插件' || name === '拓展包') return '工具';
  if (name === '实验室') return '通用';
  if (name === '账户') return '关于';
  if (name === '已归档的会话' || name === '已隐藏会话') return '项目';
  const category = settingsCategories.find(item => item.name === name);
  if (category) return category.sections[0].name;
  return settingsCategories.some(item => item.sections.some(section => section.name === name)) ? name : '通用';
}

export function settingsCategoryFor(name: string) {
  const section = normalizeSettingsSection(name);
  return settingsCategories.find(item => item.sections.some(item => item.name === section))!;
}

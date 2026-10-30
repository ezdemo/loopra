export const settingsCategories = [
  { name: '偏好设置', sections: [
    { name: '通用', label: '通用', keywords: '外观 主题 字体 语言 通知 动画 实验室' },
    { name: '宠物', label: '宠物', keywords: '宠物 pet 伴侣 画廊 选择 大小 位置 初始化' },
  ] },
  { name: '模型服务', sections: [
    { name: '模型供应商', label: '模型供应商', keywords: '模型渠道 API 密钥 上下文 价格' },
    { name: '模型用途', label: '模型用途', keywords: '默认模型 新会话 当前聊天 命令校验 图片理解 模型分配' },
  ] },
  { name: '智能体', sections: [
    { name: '智能体与会话', label: '会话默认', keywords: '权限 推理 计划 快速' },
    { name: '系统提示词', label: '系统提示词', keywords: 'prompt loopra.md' },
    { name: '子代理', label: '子代理', keywords: '角色 提示词 白名单 subagent' },
  ] },
  { name: '工具与集成', sections: [
    { name: '工具', label: '工具', keywords: 'tools 只读 写入' },
    { name: '插件', label: '插件', keywords: 'npm github moejs 工具 钩子' },
    { name: 'MCP', label: 'MCP', keywords: '外部 服务 连接 stdio SSE 工具权限 传输' },
    { name: 'MCP 服务器', label: 'MCP 服务器', keywords: '工具 发布 导出 MCP Server Cloudflare 隧道 连接地址' },
    { name: 'OpenAPI', label: 'OpenAPI', keywords: '接口 文档 认证' },
  ] },
  { name: '工作区与数据', sections: [
    { name: '项目', label: '工作区', keywords: '路径 工作区 目录' },
    { name: '已归档的会话', label: '已隐藏会话', keywords: '恢复 历史 归档' },
    { name: '数据面板', label: '用量', keywords: '统计 token 用量 费用' },
  ] },
  { name: '连接与帮助', sections: [
    { name: '服务器', label: '服务连接', keywords: '后端 API 连接' },
    { name: '网络代理', label: '网络代理', keywords: '代理 proxy http socks 出站 网络' },
    { name: '快捷键', label: '快捷键', keywords: '键盘 输入' },
    { name: '关于', label: '关于与存储', keywords: '本地 账户 数据存储 版本' },
  ] },
];

export function normalizeSettingsSection(name: string): string {
  if (name === '实验室') return '通用';
  if (name === '账户') return '关于';
  if (name === '拓展包') return '插件';
  const category = settingsCategories.find(item => item.name === name);
  if (category) return category.sections[0].name;
  return settingsCategories.some(item => item.sections.some(section => section.name === name)) ? name : '通用';
}

export function settingsCategoryFor(name: string) {
  const section = normalizeSettingsSection(name);
  return settingsCategories.find(item => item.sections.some(item => item.name === section))!;
}

export type SettingSearchItem = { category: string; title: string; keywords: string };

const fields: Record<string, string[]> = {
  '通用': ['外观', '语言', '界面缩放', '代码字号', '系统通知', '通知提示音', '默认打开应用', '宠物', '界面动画'],
  '关于': ['Loopra Web 服务', '数据存储', '帮助中心'],
  '项目': ['添加本地项目', '项目绝对路径', '会话管理', '需求池'],
  '服务器': ['后端 API 地址'],
  '智能体与会话': ['默认权限模式', '推理强度', '计划模式', '快速模式', '无工具调用时结束', '自动工作区上下文'],
  '模型供应商': ['新会话默认模型', '当前聊天模型', '命令校验模型', '图片理解模型'],
  '系统提示词': ['系统提示词'],
};
const aliases: Record<string, string> = {
  '外观': '主题 深色 浅色 跟随系统 theme',
  '界面缩放': '字体 大小 比例 font size zoom',
  '通知提示音': '声音 音效 sound',
  '默认打开应用': '文件管理器 终端 File Explorer Terminal Git Bash',
  '宠物': '宠物 pet',
  '界面动画': '动效 实验室 animation',
};
export const settingSearchItems: SettingSearchItem[] = Object.entries(fields).flatMap(([category, titles]) =>
  titles.map(title => ({ category, title, keywords: aliases[title] || '' })));

export function searchSettings(query: string, categories: { name: string; keywords: string }[]): SettingSearchItem[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const fields = settingSearchItems.filter(item => `${item.category} ${item.title} ${item.keywords}`.toLowerCase().includes(text));
  const sections = categories.filter(item => `${item.name} ${item.keywords}`.toLowerCase().includes(text)
    && !fields.some(field => field.category === item.name))
    .map(item => ({ category: item.name, title: item.name, keywords: item.keywords }));
  return [...fields, ...sections];
}

// Static help-center content ported from legacy `src/views/Help.vue`.
// Kept as data so the renderer stays declarative and the search can be tested
// without a DOM.

export type HelpEntry = { id: string; title: string; icon: string; preview: string; keywords: string };

export const helpSections: HelpEntry[] = [
  { id: 'quickstart', title: '快速入门', icon: '🚀', preview: '开始使用 Loopra 的基本步骤', keywords: '启动 配置 api 对话 工具' },
  { id: 'commands', title: '命令参考', icon: '⌨️', preview: '可用的斜杠命令和操作', keywords: 'slash command new clear compact export continue sessions plan execute goal hitl agree deny init plugin skills terminal help' },
  { id: 'tools', title: '工具列表', icon: '🔧', preview: '可用的 AI 工具和功能', keywords: 'read edit write bash glob grep ls sub_agent goal' },
  { id: 'config', title: '配置说明', icon: '⚙️', preview: '配置文件和选项说明', keywords: 'config.json baseUrl apiKey model workspaceDir editMode reasoningEffort lang' },
  { id: 'troubleshooting', title: '故障排除', icon: '🔍', preview: '常见问题和解决方案', keywords: '连接 失败 乱码 会话 丢失 权限' },
  { id: 'api', title: 'API 文档', icon: '📡', preview: 'RESTful API 接口说明', keywords: 'rest 接口 chat stream agent sessions tools config usage' },
  { id: 'changelog', title: '更新日志', icon: '📝', preview: '版本更新记录', keywords: '版本 release 历史' },
];

export const helpShortcuts = [
  { keys: 'Enter', desc: '发送消息' },
  { keys: 'Shift+Enter', desc: '换行' },
  { keys: 'Ctrl+K', desc: '聚焦搜索' },
  { keys: 'Ctrl+N', desc: '新建会话' },
  { keys: 'Ctrl+,', desc: '打开设置' },
  { keys: 'Escape', desc: '关闭弹窗' },
];

export const helpSteps = [
  { title: '启动系统', body: '运行 Loopra 后端，界面会自动加载配置和工具。', sample: 'mvn exec:java -pl loopra' },
  { title: '配置 API', body: '在设置 → 模型供应商中配置 API 密钥与端点。', sample: '~/.loopra/config.json' },
  { title: '开始对话', body: '在会话中输入消息，与 AI 助手进行交互。', sample: '输入您的问题…' },
  { title: '使用工具', body: '助手会自动调用合适的工具来完成任务。', sample: '工具会自动执行' },
];

export const helpCommands = [
  { name: '/new', desc: '开启新会话', example: '/new' },
  { name: '/clear', desc: '新建空白会话并保留当前工作区', example: '/clear' },
  { name: '/compact', desc: '折叠历史消息（语义摘要）', example: '/compact' },
  { name: '/export', desc: '导出当前会话的纯文本记录', example: '/export' },
  { name: '/sessions', desc: '列出、切换或清理历史会话', example: '/sessions' },
  { name: '/continue', desc: '让 AI 继续上一次生成', example: '/continue' },
  { name: '/plan', desc: '进入计划模式（只读探索，提交计划供审查）', example: '/plan 修复登录问题' },
  { name: '/execute', desc: '退出计划模式并批准待审查计划', example: '/execute' },
  { name: '/goal', desc: '创建和管理当前会话 Goal', example: '/goal create 修复登录问题' },
  { name: '/hitl', desc: '切换 HITL 模式（free/approval/auto）', example: '/hitl' },
  { name: '/agree', desc: '批准 HITL 待执行的工具调用', example: '/agree' },
  { name: '/deny', desc: '拒绝 HITL 待执行的工具调用', example: '/deny' },
  { name: '/init', desc: '自动分析项目生成 loopra.md', example: '/init' },
  { name: '/plugin', desc: '外置插件管理（add/list/remove/enable/disable）', example: '/plugin list' },
  { name: '/skills', desc: '为这条消息附加技能', example: '/skills' },
  { name: '/terminal', desc: '在右栏打开命令面板', example: '/terminal' },
  { name: '/help', desc: '显示帮助信息', example: '/help' },
];

export const helpTools = [
  { name: 'read', desc: '读取文件内容', params: 'file_path, offset?, limit?', readonly: true },
  { name: 'edit', desc: '精准文本替换编辑', params: 'file_path, edits[{old_str, old_StrStartLine, new_str, replace_all}]', readonly: false },
  { name: 'write', desc: '创建或覆盖文件', params: 'file_path, content', readonly: false },
  { name: 'bash', desc: '执行 shell 命令', params: 'command, timeout?', readonly: false },
  { name: 'glob', desc: '按通配符模式搜索文件', params: 'pattern, path', readonly: true },
  { name: 'grep', desc: '递归搜索内容', params: 'pattern, path, include?', readonly: true },
  { name: 'ls', desc: '列出目录内容', params: 'path, recursive?, show_hidden?', readonly: true },
  { name: 'sub_agent', desc: '创建预设角色子代理', params: 'profile, task, instructions?', readonly: false },
  { name: 'goal_create / goal_update_step / goal_complete', desc: '创建、推进和验证会话 Goal', params: 'objective / stepIndex, status, evidence / summary', readonly: false },
];

export const helpIssues = [
  { title: '无法连接到 AI 服务', symptom: '发送消息后长时间无响应，或显示连接错误', solution: '检查 ~/.loopra/config.json 中的 baseUrl 和 apiKey 是否正确，并确认后端已启动。' },
  { title: '工具调用失败', symptom: 'AI 尝试使用工具但返回错误', solution: '检查项目路径是否正确，确保运行 Loopra 的账户有足够的文件操作权限。' },
  { title: '界面显示异常', symptom: '字符显示乱码或布局错乱', solution: '尝试切换主题或调整界面缩放，确保浏览器支持 UTF-8 编码。' },
  { title: '会话历史丢失', symptom: '重新打开后之前的对话记录消失', solution: '检查 ~/.loopra/sessions/ 目录是否有写入权限，会话会自动保存到此目录。' },
];

export const helpEndpoints = [
  { method: 'POST', path: '/api/chat/stream', desc: 'SSE 流式聊天' },
  { method: 'POST', path: '/api/chat/abort', desc: '中止当前生成' },
  { method: 'GET', path: '/api/agent/status', desc: '获取 Agent 状态' },
  { method: 'GET', path: '/api/agent/history', desc: '获取历史消息' },
  { method: 'GET', path: '/api/agent/commands', desc: '列出可用斜杠命令' },
  { method: 'GET', path: '/api/agent/prompt', desc: '查看实际系统提示词' },
  { method: 'GET', path: '/api/agent/mode', desc: '查询会话计划模式和待审查计划' },
  { method: 'POST', path: '/api/agent/mode', desc: '切换会话计划模式' },
  { method: 'GET', path: '/api/sessions', desc: '列出所有会话' },
  { method: 'GET', path: '/api/sessions/current', desc: '获取当前会话' },
  { method: 'POST', path: '/api/sessions/new', desc: '新建会话' },
  { method: 'POST', path: '/api/sessions/{name}', desc: '切换会话' },
  { method: 'DELETE', path: '/api/sessions/{name}', desc: '删除会话' },
  { method: 'DELETE', path: '/api/sessions/cleanup', desc: '清理过期会话' },
  { method: 'GET', path: '/api/tools', desc: '列出所有工具' },
  { method: 'GET', path: '/api/config', desc: '获取当前配置' },
  { method: 'GET', path: '/api/usage', desc: '获取 Token 用量统计' },
];

export const helpChangelog = [
  {
    version: 'v1.0.0', date: '2024-03-20',
    changes: [
      { type: '新增', desc: '初始版本发布' },
      { type: '新增', desc: '支持 OpenAI 兼容 API' },
      { type: '新增', desc: '文件操作工具集' },
      { type: '新增', desc: '会话管理和持久化' },
      { type: '新增', desc: '流式输出支持' },
      { type: '新增', desc: '计划模式（/plan 只读探索 + submit_plan 提交计划 + /execute 批准执行）' },
      { type: '新增', desc: '深色/浅色主题' },
    ],
  },
];

export const helpConfigOptions = [
  { name: 'baseUrl', desc: 'OpenAI 兼容 API 的基础 URL' },
  { name: 'apiKey', desc: 'API 密钥' },
  { name: 'model', desc: '使用的模型名称' },
  { name: 'workspaceDir', desc: '项目目录路径' },
  { name: 'editMode', desc: '编辑模式 (free / approval / auto)' },
  { name: 'reasoningEffort', desc: '推理强度 (low/medium/high/max)' },
  { name: 'modelChannels[].models[].maxTokens', desc: '按模型配置单次请求最大输出 token 数（包含推理 token）；未配置时使用默认值' },
  { name: 'lang', desc: '界面语言 (ZH/EN)' },
];

export const helpConfigSample = `{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-api-key",
  "model": "deepseek-v4-flash",
  "workspaceDir": ".",
  "editMode": "auto",
  "reasoningEffort": "max",
  "lang": "ZH"
}`;

export type HelpSearchHit = { section: HelpEntry; matches: string[] };

/** Case-insensitive search across section metadata and the entries they list. */
export function searchHelp(query: string): HelpSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: HelpSearchHit[] = [];
  for (const section of helpSections) {
    const matches: string[] = [];
    if (`${section.title} ${section.preview} ${section.keywords}`.toLowerCase().includes(needle)) matches.push(section.preview);
    const collect = (entries: { [key: string]: unknown }[], fields: string[]) => {
      for (const entry of entries) {
        const text = fields.map(field => String(entry[field] ?? '')).join(' ');
        if (text.toLowerCase().includes(needle)) matches.push(text);
      }
    };
    if (section.id === 'commands') collect(helpCommands, ['name', 'desc']);
    if (section.id === 'tools') collect(helpTools, ['name', 'desc', 'params']);
    if (section.id === 'troubleshooting') collect(helpIssues, ['title', 'symptom', 'solution']);
    if (section.id === 'api') collect(helpEndpoints, ['path', 'desc', 'method']);
    if (section.id === 'config') collect(helpConfigOptions, ['name', 'desc']);
    if (section.id === 'quickstart') collect(helpSteps, ['title', 'body']);
    if (matches.length) hits.push({ section, matches: [...new Set(matches)].slice(0, 3) });
  }
  return hits;
}

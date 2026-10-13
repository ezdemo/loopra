# 新前端迁移交接（2026-10-13，第 29 轮）

任务：对照 `loopra-front/legacy.html`（旧 Vue 源码 `loopra-front/src/**`），把新 React 前端（`loopra-front/web/`）缺失功能逐项补齐。用户要求持续推进，不要停下等确认。

所有改动**尚未提交**。工作区里还有上一轮及更早的改动（含 Java 测试隔离、`loopra/pom.xml`、`ProjectRegistry`），**不要回退任何既有修改**。

## 环境

- 后端 `http://127.0.0.1:4567`，前端 dev `http://127.0.0.1:3000`（本轮期间都在运行，未重启）。
- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json`
- 测试：`cd loopra-front; node --test web/tests/*.test.mjs`（当前 **281 项全部通过**）
- 构建：先 `$env:TEMP="$PWD\..\.cache\frontend-build-temp"; $env:TMP=$env:TEMP`，再 `node node_modules/vite/bin/vite.js build`（Windows esbuild 临时文件需要此规避）
- 浏览器：cua_repl，IAB `browserId=2`，tab `cua.getTab("1")`，`http://127.0.0.1:3000/`。

## 本轮完成并已验证

### 1. 修复上一轮遗留的失败测试

`web/tests/workspace-manage.test.mjs`：`@nextui-org/react` stub 补 `Spinner`，`../backend` stub 补 `serverAddress`；排序用例补一次带新顺序的重渲染断言（原先断言在不会重渲染的桩上必然失败）。**测试桩修正，未改产品代码迁就测试。**

### 2. 输入栏：服务端斜杠指令 + 技能（新迁移）

- `web/src/composer.ts`：`serverSlashCommands()`（过滤 `/plan`、`/execute`，追加 `/skill:<name>`）、`mergeSlashCommands()`（本地可执行指令优先，避免重复 id）。
- `web/src/components/Composer.tsx`：挂载时拉取 `/agent/commands` 与 `/agent/skills`，与本地 `/new`、`/continue`、`/skills`、`/help` 合并；服务端指令选中后写入输入框交给后端。
- 浏览器实测：输入 `/` 后出现 `/agree`、`/compact`、`/deny`、`/goal`、`/hitl`、`/init`、`/plugin`、`/sessions` 等服务端指令。该后端未有技能，故无 `/skill:` 项（合并逻辑有单测覆盖）。

### 3. 输入栏：常用要求改为服务端同步（新迁移）

- `GET /prompt-presets` 读取、`PUT /prompt-presets` 保存；`composer.ts` 的 `presetPayload()` / `presetsFromServer()` 负责 `name ↔ label` 字段映射（服务端 schema 是 `{id,label,text}`）。
- 行为对齐旧版：服务端为空时列表为空（本地 localStorage 仅作缓存/离线回退）。

### 4. 输入栏：真实 `/usage` 上下文用量（新迁移）

- 新增 `web/src/usage.ts`：`usagePath()`、`contextFromUsage()`。
- `Composer.tsx` 在会话打开时请求 `/usage?workspaceHash=&sessionName=`，用 `lastPromptTokens`/`maxContextTokens`/`contextEstimate` 替换本地估算；无数据时回退本地估算。
- 浏览器实测：`8,255 / 256K · 3.2%`，标注“上下文窗口 · 服务端统计”，分类为系统指令/工具定义/用户消息，底部显示“服务端统计：输入 … 输出 … 费用 …”。

### 5. 输入栏：PDF / Word / Excel 解析 + 长粘贴保存（新迁移）

- 新增 `web/src/documents.ts`：`fileKind()`、`formatFileSize()`、`truncateText()`、`extractDocumentText()`（惰性加载 `pdfjs-dist`、`mammoth`、`xlsx`），常量 `MAX_TEXT_FILE_SIZE`/`MAX_DOC_FILE_SIZE`(30MB)/`MAX_EXTRACT_CHARS`/`MAX_PDF_PAGES`/`LARGE_PASTE_THRESHOLD_CHARS`。
- `Composer.tsx`：`addFiles()` 按类型解析文档为文本附件；文件选择器补 `accept` 列表；上传按钮文案更新为“图片、文本、PDF、Word、Excel”。
- 长粘贴（纯文本 > 8000 字符）走 `POST /files/paste` 存进项目，失败时把原文恢复到输入框。
- 新增 `web/src/vendor.d.ts` 声明 `mammoth/mammoth.browser`。
- 浏览器实测：上传 `.xlsx` 与 `.pdf` 均出现附件 chip（解析失败只提示、不加 chip）；`extractDocumentText` 的 xlsx 路径有集成单测。

### 6. Markdown：KaTeX 数学公式（新迁移）

- 新增依赖 `remark-math@^6`、`rehype-katex@^7`（已写入 `package.json` 与 `pnpm-lock.yaml`）。
- `web/src/markdown-math.ts` 的 `normalizeMathMarkdown()` 对齐旧版 texmath 行为：行内 `$$...$$` 提升为块级显示公式；边缘含空白/跨行的非法 `$...$` 转义为字面量（`$5 和 $6` 不再误判）；代码块与行内代码不处理。
- `Markdown.tsx` 使用 `remarkMath` + `rehypeKatex` 并引入 `katex/dist/katex.min.css`。
- 验证：单测直接挂载真实 `Markdown` 组件断言 KaTeX 输出（行内、显示、价格、代码块）；生产构建产物含 `katex-*.css`；dev 页面已加载 230 条 `.katex` 规则。**未通过真实发消息做端到端渲染验证。**

### 7. 本轮新增测试

`web/tests/composer-server.test.mjs`（指令/预设映射、usage 视图）、`web/tests/documents.test.mjs`（类型/大小/截断 + xlsx 解析）、`web/tests/markdown-math.test.mjs`（KaTeX 渲染 + 归一化）。

## 尚未迁移 / 待办

- 会话批量清理入口是否需要在侧栏再补（设置页已接 `DELETE /sessions`、`/sessions/cleanup`）。
- 旧版其他 Markdown 能力：GitHub 风格告警框（`> [!NOTE]` / `:::note`）、图片放大预览。
- Electron 桌面能力：交互终端、内置浏览器/元素检查器、独立桌面宠物、唤起主窗口（`src/Desktop*.vue`、`src/components/AIBrowser.vue`、`src/utils/ipcPayload.js`）。
- 对照 `src/views/Settings.vue` 与 `src/App.vue` 继续逐项核对剩余高级设置（不要仅因有 API 就认为已迁移）。
- 长粘贴、文档上传只在浏览器确认了 chip 生成，未做真实发送后的后端内容断言。

## 关键参考

- 旧 UI：`loopra-front/src/App.vue`、`src/views/Chat.vue`、`src/views/Settings.vue`、`src/components/ChatInput.vue`、`src/utils/highlight.js`（math/告警框/高亮规则）、`src/services/api.js`。
- 后端 schema：`loopra/src/main/java/site/sorghum/loopra/web/controller/`、`web/model/`（`UsageDTO`、`CommandMetaDTO`）、`web/controller/PromptPresetController.java`、`WorkspaceFileController.java`（`/files/paste`）。
- 测试隔离约定见 `docs/testing-isolation.md`：不要用真实后端/用户工作区做写操作验证；前端测试用 mock fetch/DOM。

## 第 3–4 轮进展（2026-10-12 续）

### 第 3 轮（已完成，本文件作者补记）

- 图片放大预览：`web/src/components/ImagePreview.tsx`（Provider + portal + Esc/遮罩关闭），用户消息图片与 Markdown 图片都可放大；样式在 `chat-blocks.css`。
- Markdown 本地文件路径链接：`web/src/markdown-links.ts` + `Markdown.tsx` 的 `OpenFileContext`，点击本地路径打开工作区 diff（`BlockRenderer.tsx` 传 `actions.onDiff`）。
- Markdown 原文渲染：`remark-breaks` + `rehype-raw` + `web/src/markdown-schema.ts`（对齐旧 `utils/sanitize.js` 白名单），单换行变 `<br>`，raw HTML 保留但脚本/事件属性被清理。
- 项目会话管理对话框：`web/src/components/ProjectSessions.tsx`（刷新 / 清空 / 删除项目），入口在每个工作区标题行的「管理」按钮。
- 排队消息：`web/src/message-queue.ts` + `Composer.tsx` 队列区，流式期间「加入队列 / 停止生成」，回复结束后自动发送。
- 会话后台运行状态轮询：`App.tsx` 的 `syncSessionRun`（每 2.5s 查 `/agent/session-status`，running→false 且有队列时继续发送），`remoteRun` 按当前会话门控避免误报。

### 第 4 轮（本轮）

- 帮助中心：`web/src/help.ts`（数据 + 搜索）+ `web/src/components/Help.tsx` + `web/src/help.css`，对齐旧 `views/Help.vue` 的 7 个章节、快捷键、命令表、工具卡、配置示例、故障排除、API 端点、更新日志，支持搜索与目录跳转；入口在侧栏「帮助中心」。
- 会话管理对话框：`web/src/session-stats.ts`（沿用旧 Sessions.vue 的四张统计卡公式）+ `web/src/components/SessionsManager.tsx` + `web/src/sessions.css`，含统计卡、搜索、分页、加载 / 导出 JSON / 删除、按工作区清空；入口在侧栏「会话管理」。
- 侧栏补齐旧 Sidebar.vue 的入口：底部快捷图标（工具列表 / 子代理 / 数据面板 / 切换主题），会话行悬停「刷新 / 删除」，隔离分支会话显示 🌲 徽标。
- 单会话刷新 `refreshSessionChat()`：拉 `/agent/history` 覆盖该会话消息并提示，不切换当前会话。
- `RemoteSession` / `Session` 透传 `messageCount` 与 `worktreeMode`（`backend.ts`、`lib.ts`）。
- 验证：`tsc -b web/tsconfig.json` 通过；`node --test web/tests/*.test.mjs` **101 项全过**（新增 `session-stats.test.mjs`、`help.test.mjs`、`sessions-manager.test.mjs`）；`vite build` 通过（产物 css 含 help/sessions 样式）。
- 浏览器验收（dev 3000）：侧栏出现「会话管理 / 帮助中心 / 工具 / 子代理 / 数据面板 / 切换主题」；帮助弹窗 7 个目录、17 个 API 端点、搜索命中「命令参考 + API 文档」；会话管理显示 4 个真实会话与统计卡、搜索过滤生效；单会话刷新提示「nihao 已刷新」；主题可交替切换；无 console error。
- 注意：dev server 中途退出过一次，已用 `node node_modules/vite/bin/vite.js`（后台会话）重新拉起；破坏性操作（删除会话 / 清空工作区）只在单测里断言端点，未在真实后端执行。

### 仍未迁移 / 待办（更新）

- Electron 桌面能力：交互终端（xterm + IPC）、内置浏览器 / 元素检查器、独立桌面宠物窗口、唤起主窗口、更新面板（`src/Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`utils/ipcPayload.js`）。
- 桌面聊天工具面板：`SubAgentPanel`（子代理回放标签）、`ProjectCapabilitiesPanel`（项目 Skill/MCP 状态）在旧版仅桌面窗口使用；Web 端未迁移，如需可在工作区面板加标签。
- 首启设置屏（`SetupScreen.vue`）：新前端用「连接失败横幅 + 服务器设置」替代，未做同版视觉。
- 后台命令会话（`BashSessionManager.vue`）的复制命令/工作目录按钮未迁移（列表/日志/终止已在新终端面板）。
- 第 3 轮的图片预览、文件链接、raw HTML、真实排队发送仍未做「带图消息 / 本地路径 / 长文本」端到端浏览器验收。


## 第 5 轮（2026-10-13 续）

本轮先把第 4 轮遗留的失败测试修完，再补 3 个仍缺的 web 端功能，最后做了浏览器端到端验收并修掉一个真实回归。

### 1. 修掉 `subagents-panel.test.mjs` 的流式回放失败（产品代码 bug）

- 现象：`continuing a run streams sub_* events into the replay` 断言失败，流式追加的 `sub_user` / `sub_content` 块被清空。
- 根因：`SubAgentsPanel.tsx` 里列表轮询和回放共用同一个 `revision`，`send()` 的 `finally` 递增它后，`useRemote` 重新拉取已存事件并把流式内容覆盖回旧数据。
- 修法（`web/src/components/SubAgentsPanel.tsx`）：拆成 `listRevision`（轮询/删除/发送后只刷新列表）与 `eventRevision`（手动刷新才重读已存回放），文档里写清了为什么保留两个 revision。
- 附带：轮询加 `document.visibilityState === 'hidden'` 守卫；测试文件里的 fetch stub 移到点击之后并补 `setTimeout` 让 SSE 跨微任务完成，三个用例都包 `try/finally` 卸载，避免测试进程挂起。

### 2. 项目能力面板（旧 `ProjectCapabilitiesPanel.vue`）

- 新增 `web/src/capabilities.ts`：`projectCapabilitiesPath(hash, refresh?)`（GET `/agent/project-capabilities`、POST `.../refresh`）、`projectSkillsOf`（只保留 `scope === 'project'`）、`mcpToolCount`、`mcpTypeLabel`、`mcpStatusLabel`、`projectSkillEmptyText`、`mcpEmptyText`。
- 新增 `web/src/components/ProjectCapabilities.tsx` + `web/src/capabilities.css`（main.tsx 已 import）：概览（Skill / MCP / 工具数）、项目 Skill 列表、可展开的 MCP 服务器（工具名 / 加载失败），右上角刷新走 `POST .../refresh`。
- 入口：工作区面板新增「能力」标签（`Panels.tsx`），无工作区时提示先选项目。

### 3. 后台进程列表（旧 `BashSessionManager.vue` 的剩余部分）

- 新增 `web/src/bash-sessions.ts`：`bashSessionsPath` / `bashSessionLogPath`、`bashSessionSummary`（`N 个运行中 · 共 M 个进程`）、`bashSessionState`、`formatBashDuration` / `formatBashUptime`（沿用旧版单单位折叠：秒/分钟/小时/天）、`workspaceName`。
- `Panels.tsx` 的 `TerminalPanel` 重写为列表式：每行状态点 + 命令（点击复制）+ 状态 / 运行时长 + 工作目录（点击复制），保留原「查看日志 / 停止进程 / 刷新 / 关闭」；复制用 `navigator.clipboard` 并提示「复制成功」，定时器在卸载时清理（避免测试结束后仍有异步活动）。样式补在 `styles.css`（`.bash-list/.bash-row/.bash-copy/...`），并把 `.terminal-output` 改为弹性高度（`motion.css` 里写死的 `height` 已删除）。

### 4. 设置：模型供应商预设（旧 `Settings.vue` 的「AI模型自动填入 → 选择服务商」）

- `web/src/settings-data.ts` 新增 `providerPresets`（SiliconFlow / DeepSeek / 小米 / 小米TokenPlan / OpenRouter / OpenCode Go）、`providerPresetFor(baseUrl)`、`applyProviderPreset(provider, preset)`（用户已填名称时保留名称，与旧弹窗一致；OpenCode Go 带 `opencode` 特殊兼容）。
- `ModelProviderSettings.tsx` 的表单顶部加「常用服务商（自动填入地址）」下拉；地址/密钥与「获取模型」流程沿用已有实现。
- 说明：旧的「编辑模式（free/approval/auto）」在新前端由「智能体与会话 → 默认权限模式」承担（两者在旧版都写同一个 `hitl` 字段），未再重复加一份单选。

### 5. 修掉本地文件链接的真实回归（第 3 轮遗留的未验收项）

- 浏览器实测发现：`[a](src/x.ts)` 这种相对路径能变成 `.ai-file-link`，但 `[a](C:/repo/src/x.ts)`（含盘符）的 `href` 被清空，点击无效。
- 根因：`react-markdown` 默认 `urlTransform` 会把首段带冒号的地址当未知协议置空；即使保留，`rehype-sanitize` 的 `protocols.href` 白名单也会删掉。
- 修法：`markdown-links.ts` 新增 `LOCAL_FILE_SCHEME = 'loopra-file:'`、`localFilePath()`、`rehypeLocalFileLinks()`（在 `rehype-raw` 与 `rehype-sanitize` 之间把命中本地路径的链接改写成该 scheme，并补 `title="打开文件预览"`）；`markdown-schema.ts` 的 `protocols.href` 追加 `loopra-file`；`Markdown.tsx` 用自定义 `urlTransform` 放行该 scheme 与本地路径，`MarkdownLink` 统一用 `localFilePath()` 判断。
- 注意：`C:\backslash\path` 形式在 remark 解析阶段就会丢掉反斜杠，旧版 markdown-it 同样如此，未强行兼容；相对路径与正斜杠绝对路径现在都可用。

### 6. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **125 项全过**（新增 `bash-sessions.test.mjs` 5 项、`capabilities.test.mjs` 4 项、`terminal-panel.test.mjs` 3 项；`markdown.test.mjs` 补 2 项）。
- 生产构建：`$env:TEMP="C:\Users\15614\Documents\Code\loopra\.cache\frontend-build-temp"; $env:TMP=$env:TEMP; node node_modules/vite/bin/vite.js build` 通过（新样式已进 `dist/renderer/assets/css/main-*.css`）。
- 浏览器验收（dev 3000，真实后端 4567）：
  - 工作区面板出现「文件 / Git / 定时 / 子代理 / 能力 / 环境」；「能力」标签渲染 `项目能力 · loopra-web-ui · 0 Skill / 0 MCP / 0 工具` 及空状态文案，点刷新命中 `POST /agent/project-capabilities/refresh`。
  - 终端面板显示「后台进程 + 暂无后台进程」空态（当前无后台命令，行渲染由 `terminal-panel.test.mjs` 覆盖）。
  - Markdown 管线用临时 harness（`.qa/markdown-e2e.html` + `.qa/markdown-e2e.tsx`，验收后已删除）在浏览器里渲染真实组件：`> [!NOTE]` 变告警卡、普通引用仍是 blockquote、raw HTML 保留且 `<script>`/`onerror` 被清理、`javascript:` 链接被清空、行内 KaTeX 渲染且 `$5 和 $6` 不被误判、图片点击打开灯箱且按钮与 Esc 均可关闭、相对路径与 `C:/...` 链接都变成 `.ai-file-link` 并回调打开路径。
  - `tab.dev.logs()` 里的 3 条 `[vite] Failed to reload ...` 是编辑过程中 HMR 的历史记录，reload 后模块均返回 200、页面正常，非当前错误。

### 仍未迁移 / 待办（第 5 轮更新）

- Electron 桌面能力（交互终端 / 内置浏览器 / 元素检查器 / 桌面宠物窗口 / 消息窗口 / 需求板 / 更新面板）**按设计**仍走旧 Vue 渲染器：`loopra-front/src/entry.js` 用 `usesLegacyRenderer(search, !!window.electronAPI)` 判断，带 `desktopShell|desktopSplash|desktopUpdate|desktopOnboarding|desktopChatTab|desktopSearch|desktopMessage|desktopPopup|desktopPet|requirementBoard|aiBrowser|elementInspector` 或存在 `window.electronAPI` 时加载 `src/main.js`，否则加载 `web/src/main.tsx`。除非要去掉旧渲染器，否则不属于「缺失功能」，但新前端目前**没有**任何 IPC 桥接。
- 文件编辑（旧 `FileEditor.vue` + `EditorTabs.vue` + Monaco）依赖 `window.electronAPI.fileExplorer` 读写，Web 端后端也没有写文件的接口（`WorkspaceFileController` 只有 `tree/search/delete/paste`），因此浏览器的文件面板保持只读预览 + 删除。
- 首启设置屏（`SetupScreen.vue`）：新前端用「连接失败横幅 + 设置 → 服务连接」替代，未做同版视觉。
- 真实写操作仍未端到端验收（按 `docs/testing-isolation.md` 不在用户真实工作区里做写操作）：排队消息真实发送、长粘贴 `POST /files/paste`、文档上传送后端、`/sessions/cleanup` 与删除会话等破坏性入口都只在单测里断言端点与载荷。

## 第 6 轮（2026-10-13 继续）

本轮把 `Chat.vue` 里最后两块没迁的交互补上并做了浏览器验收：计划模式审查条，以及会话导出。

### 1. 计划模式审查条（旧 `Chat.vue` 的 `plan-review` 插槽 + `discardPlanDialog`）

- 新增 `web/src/components/PlanReview.tsx`：状态条（`计划模式` + `只读探索`/`待审查`）、有 `pendingPlan` 时显示可折叠的计划正文（Markdown 渲染）与「批准并执行」按钮，右上角「退出计划模式」。
- `App.tsx` 接线：
  - 新状态 `pendingPlan` / `discardPlan` / `planBusy`；`selectSession` 从 `GET /agent/mode` 读取 `pendingPlan`，`newSession` 清空。
  - 流式回调新增 `plan_submitted`（写入 `pendingPlan`）与 `mode_changed`（同步 `plan` 开关）事件，早退不落进消息块。
  - `sendMessage` 新增 `action` 参数：approve 时以 `action: 'execute_plan'` 静默发送（不加用户气泡），完成后回读 `GET /agent/mode` 刷新状态；`execute_plan` 不再重复 `POST /agent/mode` 进入计划模式。
  - `saveOptions` 在「计划模式 true→false」时改为打开「退出计划模式」确认框（`ConfirmAction`），文案随是否有待审查计划变化；确认后 `POST /agent/mode` 关闭并清空 `pendingPlan`。
- 样式：`styles.css` 新增 `.plan-review-band/.plan-review-head/.plan-approve-btn/...`（沿用新主题变量）。
- 测试：`web/tests/plan-review.test.mjs` 4 项（只读态无 approve、待审查态显示正文与按钮、approve/exit 回调、busy 禁用）。

### 2. 会话导出（旧 `Chat.vue` 头部的「导出」按钮）

- 新增 `web/src/chat-export.ts`：`chatExportText(messages)`（对齐旧格式：`[时间] 用户/助手:`，助手按 `思考/内容/工具` 分块，`---` 分隔）+ `downloadText()`。
- `App.tsx` 会话「⋯」菜单新增「导出对话」，导出 `chat-YYYY-MM-DD.txt`。
- 测试：`web/tests/chat-export.test.mjs` 2 项。

### 4. 用量面板升级（旧 `Dashboard.vue`）

- 新增 `web/src/components/UsageDashboard.tsx`（`ResourceManagers.tsx` 改为再导出）：
  - 6 张概览卡：累计 tokens / 单日峰值 tokens / 活跃天数 / 缓存命中率（含 `totalCacheMiss`）/ 总请求次数 / 总费用。
  - `Token 活跃度` 周热度图：`usageHeatmap()` 复刻旧版的周一开头分列、月份标签（相邻月不足 2 列时隐藏开头月）、5 级配色与图例。
  - 活跃度 / Token / Cache 三块指标面板；每日明细表；模型用量带输入/输出/缓存读取拆分。
- 样式加入 `workbench.css`（`.usage-heatmap-*/.usage-cell.level-*/.settings-metric-panels`），窄屏指标面板单列。
- 测试：`web/tests/usage-dashboard.test.mjs` 3 项（`compactTokens` 千/万/亿、周热度图分列与月份标签、周一偏移补空）。浏览器实测 `/usage/dashboard` 渲染 6 卡 + 30 格热力图 + 3 指标面板，无 console error。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **131 项全过**（新增 `plan-review.test.mjs` 4、`chat-export.test.mjs` 2）。
- 生产构建：`vite build` 通过。
- 浏览器验收（dev 3000 + 后端 4567）：选中会话点「计划模式」开关后出现审查条 `计划模式 · 只读探索` + 「计划模式」chip；点退出弹出「退出计划模式 / 将退出计划模式并恢复全部工具。」确认框，确认后审查条消失、提示「已退出计划模式」、无 console error。会话菜单出现「导出对话」，点击后提示「对话已导出」且无报错。
- 说明：计划模式开关会向真实会话元数据写入 `planMode` 标记（`JsonlSessionStore.setPlanMode`），验收后已把该键从 `.meta` 移除还原；「待审查 + 批准并执行」路径因需要真实模型提交计划，仅用单测覆盖组件渲染，App 侧以代码路径与事件处理覆盖。

### 仍未迁移 / 待办（第 6 轮更新）

- Electron 桌面能力、文件编辑（Monaco，无写文件接口）、首启设置屏视觉：同上，属设计取舍。
- 用量面板已升级到接近旧 `Dashboard.vue`：6 张卡（累计/单日峰值/活跃天数/缓存命中率/请求次数/费用）、周一开头的周热度图 + 月份标签 + 图例、活跃度/Token/Cache 三块指标、每日明细与带输入/输出/缓存拆分的模型用量（`web/src/components/UsageDashboard.tsx`）。仍未做：模型列表分页、按模型价格的费用预估明细。
- 真实写操作仍未端到端验收（见 `docs/testing-isolation.md`）。


## 第 7 轮（2026-10-13 继续）

上一轮删掉 `web/src/components/FilesPanel.tsx` 准备重写但没写完，导致 `Panels.tsx` 的 import 悬空（`tsc` 必失败）。本轮先把它补齐，再补上 diff 查看器。

### 1. `DiffView` + `diff.ts`（旧 `DiffViewer.vue`）

- `web/src/diff.ts`：`parseSideBySide(diff)` 把 unified diff 解析成左右并排行（成对的 `-`/`+` 合并为 `replace`，纯删/纯增分别进 `remove`/`add`，`@@ -0,0 +0,0 @@` 记为 `empty`，行号与 `hunkIndex` 都带上），`diffHunkCount(rows)` 统计差异块数。
- `web/src/components/DiffView.tsx`：并排渲染 + 差异块导航（上一块/下一块 + `n/m` 位置，滚动时按 `[data-change]` 行同步当前块），无 diff 时显示「该文件没有未提交的改动。」，diff 无 hunk 时退回原文 `<pre className="workspace-preview-raw">`。
- 样式加到 `web/src/workbench.css`：`.diff-hunk-nav/.diff-hunk-position/.diff-sbs*/.diff-sbs-add|remove|replace|context|empty`（用主题变量与 `color-mix`）。

### 2. 文件面板重写（旧 `FilePanel.vue` + `DiffViewer.vue`）

- 重写 `web/src/components/FilesPanel.tsx`（props 仍是 `{ api, workspaceHash, revision, onAdd }`，`onAdd(path, selection?)`）：
  - 按需加载目录树（`GET /files/tree?workspaceHash=&path=`），单一路径目录自动展开（最多 32 层）。
  - 顶部搜索 200ms 防抖走 `GET /files/search?workspaceHash=&query=`，命中列表用后端的 `path` 展示。
  - 预览面板：「原文件 / Git Diff」切换 —— 原文件 `GET /git/working-file-content?workspaceHash=&path=`，Diff `GET /git/diff-content?workspaceHash=&path=` 并交给 `DiffView`；头部「引用文件」`onAdd(path)`。
  - 右键菜单：文件「打开文件 / 添加到上下文 / 删除」，目录「刷新 / 删除」；删除走 `ConfirmAction` → `DELETE /files/delete?workspaceHash=&path=`，成功后本地从树/搜索/预览里摘掉。
  - 预览里框选文字会浮出「添加到会话」按钮，回调 `onAdd(path, selection)`（对齐旧 `DiffViewer` 的 `addToSession`）。
- 样式：`web/src/workbench.css` 新增 `.file-search/.workspace-tree-*/.tree-chevron|folder|file|loading|empty/.file-search-result*/.workspace-preview-raw/.preview-body/.diff-view-tabs/.diff-selection-action/.file-context-menu`。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **141 项全过**（新增 `diff.test.mjs` 3、`files-panel.test.mjs` 4）。
- 生产构建：`$env:TEMP="C:\Users\15614\Documents\Code\loopra\.cache\frontend-build-temp"; $env:TMP=$env:TEMP; node node_modules/vite/bin/vite.js build` 通过（`diff-sbs-row` 等新样式已进 `dist/renderer/assets/css/main-*.css`）。
- 浏览器验收（dev 3000 + 后端 4567，工作区 `loopra-web-ui`）：打开改动面板 → 「文件」标签按需加载目录树；点目录展开命中 `/files/tree?...&path=`；搜索框输入命中 `/files/search`；点 `README.md` 显示原文件；切「Git Diff」（后端对该未跟踪文件返回整份新增 diff `@@ -0,0 +1,68 @@`）渲染出 68 行并排 `diff-sbs-add` 行 + 差异块导航 `0/1`；右键菜单出现「打开文件 / 添加到上下文 / 删除」，点「添加到上下文」提示「已加入消息上下文」。未在真实工作区点「删除」。

### 仍未迁移 / 待办（第 7 轮更新）

- Electron 桌面能力、文件编辑（Monaco，后端无写文件接口）、首启设置屏视觉：同上，属设计取舍。
- 真实写操作（删除文件/目录、`POST /files/paste`、排队消息真实发送、文档上传、`/sessions/cleanup`、删除会话）仍未端到端验收，仅在单测里断言端点与载荷（遵循 `docs/testing-isolation.md`）。
- 用量面板：仍未做模型列表分页、按模型价格的费用预估明细。
- 会话批量清理、工作区排序/移除已由 `BackendProjects`/`SessionsManager` 覆盖到 web（见 `workspace-manage.test.mjs`）。

## 第 8 轮（2026-10-13 继续）

补齐旧 `VersionInfoPanel.vue` 的「设置 → 关于」版本与更新面板：之前新前端只有一个占位卡片。

### 1. 更新脚本工具（旧 `src/utils/updateScripts.js` + `src/utils/constants.js`）

- 新增 `web/src/update-scripts.ts`：`MIRROR_SOURCES`、`UPDATE_SOURCE_NORMAL`、`isMirrorSource`、`loadUpdateSource`/`saveUpdateSource`（沿用旧 localStorage 键 `loopra.updateSource`）、`updateScriptName`、`buildUpdateCommand`（Windows `irm ...setup[-mirror].ps1 | iex` / Unix `curl ...setup[-mirror].sh | bash`，具体镜像 URL 会加 `LOOPRA_MIRROR` 前缀）、`buildUpdatePrompt`、`compareVersions`、`RELEASE_LATEST_URL`/`RELEASES_URL`/`GITEE_HOME_URL`。

### 2. 关于页版本面板

- 新增 `web/src/components/VersionInfo.tsx`：核心服务版本（`GET /version/`）、最新发布 + 查看发布页链接、更新源下拉、更新命令（点击复制）、`检查更新`（`GET /version/check`，显示 `新版`/`已是最新` 与检查时间）、`更新核心服务`、`下载桌面端（推荐）`。
- `Settings.tsx` 的 `关于` 标签页渲染 `<VersionInfo>`（保留 Loopra 标题卡与数据存储说明）。
- `App.tsx`：`sendMessage` 增加第 4 个参数 `fresh`（忽略当前会话、强制新建）；新增 `autoUpdate()` —— 新建会话并发送 `buildUpdatePrompt(loadUpdateSource())`（对齐旧 App.vue 的 `runInFreshSession(updateCommand)`），通过 `onAutoUpdate` 传给设置页。
- 样式加在 `web/src/settings.css`：`.version-value/.version-link/.version-command/.uc-badge/.version-actions`。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **149 项全过**（新增 `update-scripts.test.mjs` 4、`version-info.test.mjs` 4）。
- 生产构建：`vite build` 通过。
- 浏览器验收（dev 3000 + 后端 4567）：侧栏头像进入「设置 → 关于与存储」，显示 `版本与更新 / 核心服务 v26.9.91（未检查）/ 最新发布 — / 更新源 / 更新命令（PS · sh）`；点「检查更新」后命中 `GET /version/check`，显示「已是最新 + 上次检查时间 + 最新发布 v26.9.91」，无报错；点 PS 命令提示「已复制到剪贴板」；把更新源切到 `镜像 · gh-proxy.org` 后命令变为 `$env:LOOPRA_MIRROR=…; irm ...setup-mirror.ps1 | iex`，随后已切回「直连（GitHub）」。`更新核心服务`（会新建真实会话并调用模型）未在真实工作区点击，已由 `version-info.test.mjs` 断言回调。

### 仍未迁移 / 待办（第 8 轮更新）

- Electron 桌面能力、文件编辑（Monaco，后端无写文件接口）、首启设置屏视觉：同上，属设计取舍。
- 用量面板：仍未做模型列表分页、按模型价格的费用预估明细。
- 真实写操作（删除文件/目录、`POST /files/paste`、排队消息真实发送、文档上传、`/sessions/cleanup`、删除会话、`更新核心服务`）仍未端到端验收，仅在单测里断言端点与载荷（遵循 `docs/testing-isolation.md`）。

## 第 9 轮（2026-10-13 继续）

先修掉第 8 轮遗留的工具管理器测试，再补上两处对照旧版发现的真实缺口（用量面板费用/分页、生成速度指示）。

### 1. 工具管理器测试修复（第 8 轮遗留）

- `web/tests/tool-manager.test.mjs`：`ResourceManagers.tsx` 末尾 `export { UsageDashboard } from './UsageDashboard'` 需要在 data-URL 模块里也解析到，补了 stub；另外列表在操作后会重新拉取并重建卡片，三态/启停两个用例改为每次操作前重新查询卡片（产品代码未迁就测试）。

### 2. 用量面板：费用预估 + 模型分页（旧 `Dashboard.vue`）

- `web/src/components/UsageDashboard.tsx`：
  - 新增 `formatCost()`（对齐旧版：小于 0.01 且大于 0 时保留 4 位小数）与 `usageModelPage()`（每页 4 个、页码越界自动夹回、空列表至少 1 页）。
  - 概览卡回到旧版 5 张（累计 tokens / 单日峰值 tokens / 活跃天数 / 缓存命中率 / 总请求次数），新增独立的「费用预估」区（预估总费用 / 单日费用峰值）。
  - Token 指标补「缓存写入 tokens」；模型卡片显示「默认渠道 / model provider」、费用与「缓存写入 0」；模型用量区加 `n / m` + 上一页/下一页分页。
- 样式：`web/src/workbench.css` 增 `.usage-cost-cards/.usage-models-heading/.usage-model-pagination`。
- 测试：`web/tests/usage-dashboard.test.mjs` 补 `formatCost`、`usageModelPage`（共 5 项）。

### 3. 生成速度（tokens/s）实时指示（旧 `ChatInput.vue` 的 `displayTps`）

- `web/src/composer.ts`：新增 `LiveSpeed` 类型、`formatTokenSpeed()`（流式中用实时速率，结束后用平均速率并回退实时；≥100 取整）、`tokenSpeedTitle()`（完成后显示「平均 · 实时 · tokens」）。
- `web/src/backend.ts`：`StreamEvent` 补 `tokensPerSecond/avgTokensPerSecond/done/completionTokens`（后端 `token_speed` SSE，`LoopraTokenSpeedPlugin` 每 200ms 最多发一次）。
- `web/src/App.tsx`：新增 `liveSpeed` 状态；发送前清空、`token_speed` 事件写入（早退不落进消息块）、`finally` 补 `done` 与平均速率；`newSession`/`selectSession` 清空；透传给 Composer。
- `web/src/components/Composer.tsx`：`composer-right` 在上下文环左侧显示 `.composer-tps` 徽标（带 title），上下文弹层顶部补「生成速度 … · 已生成 … tokens」。样式在 `web/src/composer.css`。
- 测试：`web/tests/composer-server.test.mjs` 补 `formatTokenSpeed`、`tokenSpeedTitle`（共 6 项）。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **156 项全过**（`tool-manager` 3、`usage-dashboard` 5、`composer-server` 6）。
- 生产构建：`$env:TEMP="C:\Users\15614\Documents\Code\loopra\.cache\frontend-build-temp"; $env:TMP=$env:TEMP; node node_modules/vite/bin/vite.js build` 通过（`composer-tps`/`usage-model-pagination` 已进 `dist/renderer/assets/css/main-*.css`）。
- 浏览器验收（dev 3000 + 后端 4567，`loopra-web-ui` 工作区）：侧栏「数据面板」进入设置→用量，显示 5 张概览卡（累计 111.6万 / 单日峰值 75.9万 / 活跃 3 天 / 缓存命中率 89% / 请求 52）、三块指标（Token 指标含「缓存写入 tokens 0」）、「费用预估 · 预估总费用 ¥0.00 / 单日费用峰值 ¥0.00」、模型卡片 `deepseek-v4.1-flash model provider · 52 次 · ¥0.00 … 缓存写入 0` 与分页 `1 / 1 ‹ ›`；无 console error。
- 说明：`token_speed` 徽标在没有真实流式回复时不显示，逻辑由 `composer-server.test.mjs` 覆盖；本轮未触发真实模型生成。

### 仍未迁移 / 待办（第 9 轮更新）

- Electron 桌面能力、文件编辑（Monaco，后端无写文件接口）、首启设置屏视觉：同上，属设计取舍。
- 用量面板：模型用量已分页，但「按模型价格的费用预估明细」仍直接用后端 `model.cost`；旧版也是同理，未再补本地计价。
- 真实写操作（删除文件/目录、`POST /files/paste`、排队消息真实发送、文档上传、`/sessions/cleanup`、删除会话、`更新核心服务`）仍未端到端验收，仅在单测里断言端点与载荷（遵循 `docs/testing-isolation.md`）。

## 第 10 轮（2026-10-13 继续）

本轮补上对照旧版发现的**最大缺口：需求池（RequirementBoard）**。旧版 `src/views/RequirementBoard.vue`（1075 行）此前完全没迁入，新前端 `web/src/**` 里搜不到任何 `requirement` 引用，而后端 `RequirementController` / `RequirementManager` / `RequirementStore` 与 `requirementBoard` 独立窗口都还在。本轮把整块能力迁到 React 工作台（作为全屏弹窗），不改后端。

### 1. 纯逻辑模块 `web/src/requirements.ts`

- 常量：四列看板 `REQUIREMENT_COLUMNS`、优先级/推理强度/审批模式选项，以及状态/优先级中文映射。
- 数据与选项：`requirementModelOptions()`（`channel::model` 选项）、`splitRequirementModel()`（拆回 `model`/`modelChannelId`，空值转 `null`）。
- 时间与调度：`formatRequirementTime()`（今天/昨天/M月D日，对齐旧 `fmtTime`）、`formatRequirementRelative()`（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期）、`requirementScheduleMin()`、`isScheduledRequirement()`、`requirementScheduleDescription()`。
- 消息流拆分（旧版核心逻辑）：`requirementComments()`（user 评论 + 紧跟的 AI 回复 + 独立展示的 `✅`/`❌` 总结；隐藏 `web_hidden` 与内部执行提示但保留其后的 AI 回复）、`requirementCommentCount()`、`requirementLogCount()`、`requirementLogMessages()`（复用 `historyMessages()` 组装执行日志）、`normalizeRequirementComment()`（把 `1) 2)` 压行的总结转成 markdown 列表）。

### 2. 组件 `web/src/components/RequirementBoard.tsx`

- 看板视图：四列（待执行/执行中/已完成/已失败）、卡片显示优先级、项目、AI 执行徽标、定时徽标与更新时间；顶部刷新 / 新建 / 关闭；空列占位。
- 详情视图：状态 + 优先级 + `#id` + 标题；描述卡；AI 执行卡按状态给出「让 AI 执行 / 取消执行 / 重新执行」以及审批待定时的「同意执行 / 拒绝执行」；删除沿用旧版**二次点击确认（3 秒超时自动解除）**。
- 评论 / 执行日志两个 tab：评论用 Markdown 渲染（含 `normalizeRequirementComment`），日志用 `BlockRenderer` 复用聊天块（推理 / 工具 / 文件改动 / 清单）；评论框 Enter 发送、Shift+Enter 换行。
- 新建需求弹窗：标题 / 描述 / 项目 / 优先级 / 模型 / 推理强度 / 审批模式 / 立即或定时执行（`datetime-local` 最小值为当前时间 +1 分钟）；创建后**立即执行会自动调用 `/requirements/{id}/run`**，对齐旧版。
- 数据流：看板每 3s 轮询（对齐旧 `POLL_INTERVAL`），详情打开时同时轮询消息流；滚动跟随在用户上滑浏览时暂停（`followRef`）。
- 端点：`GET/POST /requirements`、`DELETE /requirements/{id}`、`POST /requirements/{id}/{run|abort|approval|comments}`、`GET /requirements/{id}/messages`，均按旧版语义调用。

### 3. 样式与入口

- 新增 `web/src/requirements.css`（在 `main.tsx` 引入）：整屏看板与详情、四列网格、卡片/徽标、评论条目、创建弹窗与执行方式单选，全部走主题变量（`--surface/--line/--soft/--hover/--selected/--blue/--muted`），窄屏（≤900px / ≤640px）单列回退。
- `App.tsx`：侧栏新增「需求池」入口（与「会话管理」并列，窄屏自动收起侧栏），渲染全屏 `RequirementBoard` 弹窗。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **169 项全过**（新增 `requirements.test.mjs` 9、`requirement-board.test.mjs` 4）。
- 生产构建：`vite build` 通过（`req-board-columns` / `req-detail-topbar` / `req-create-modal` / `requirement-board-wrapper` 均已进 `dist/renderer/assets/css/main-*.css`）。
- 浏览器验收（dev 3000 + 后端 4567）：侧栏「需求池」打开整屏看板（`1280×720` 铺满，无横向溢出）；四列 + 计数 + 空状态正确；用 `POST /api/requirements` 造了一条 **定时** 验收需求（避免触发真实 AI 执行），3s 轮询后看板出现 `1 条需求`、卡片显示 `高` / `loopra-web-ui` / `AI 执行` / `定时 10/14 01:42` / `今天 01:42`；详情页显示状态、`#2e81`、描述、`定时执行：10/14 01:42 自动启动`、`评论 (0)` / `执行日志 (0)`，切「执行日志」显示「暂无执行日志」；二次确认删除后回到看板 `0 条需求`；新建弹窗默认带入渠道模型 `deepseek-v4.1-flash (Kimi Code · DeepSeek)`、推理强度/审批模式继承 `/config`，切「定时执行」出现 `datetime-local`（`min` 为当前时间 +1 分钟，未填时「创建」禁用），弹窗宽 736px 居中；无 console error。
- 清理：验收需求已通过 UI 删除，`GET /api/requirements` 回到 `[]`，`~/.loopra/requirements/requirements.json` 内容为 `[]`。

### 仍未迁移 / 待办（第 10 轮更新）

- Electron 桌面能力、文件编辑（Monaco，后端无写文件接口）、首启设置屏视觉：同上，属设计取舍。
- 需求池的真实「立即执行 → AI 流转 → 评论回复 → 审批」链路未做端到端验收（会驱动真实模型与真实项目写入），仅由单测断言端点与载荷；旧版 `requirementBoard=1` 独立窗口入口仍由 `entry-routing.js` 指向 Vue 页面（桌面窗口设计取舍）。
- 用量面板：模型用量已分页，但「按模型价格的费用预估明细」仍直接用后端 `model.cost`。
- 真实写操作（删除文件/目录、`POST /files/paste`、排队消息真实发送、文档上传、`/sessions/cleanup`、删除会话、`更新核心服务`）仍未端到端验收，仅在单测里断言端点与载荷（遵循 `docs/testing-isolation.md`）。


## 第 10 轮（续）：聊天滚动 / 消息缩略图 / 一键折叠（2026-10-13）

对照旧 `views/Chat.vue` 的滚动逻辑（1768–1930 行、`userScrolledAway`）、消息缩略图 dock（模板 178–210 行、样式 3440–3493/4028–4114 行）补上最后三块聊天交互。

### 1. 纯逻辑 `web/src/chat.ts`

- `CHAT_SCROLL_THRESHOLD = 80`、`chatNearBottom()`。
- `chatScrollState(element, previousTop, away)`：只有**向上**滚动才标记 away；滚回阈值内自动恢复跟随；返回 `{ away, showScrollButton }`。
- `truncatePreview(text, max = 40)`、`userMessageDock(messages)`（只取 user 消息并保留 `globalIndex`，用于 dock 跳转）。

### 2. 组件接线

- `web/src/components/Motion.tsx`：新增 `useCollapseAll(collapse)`，监听 `loopra:collapse-all-blocks` window 事件（ref 保存最新回调，卸载时移除监听）；`Disclosure` 内部已接入；`Enter` 透传 `data-message-id`。
- `Conversation.tsx` 的 `UserMessage` / `AssistantMessage` 各自调用 `useCollapseAll`，并给根节点加 `data-message-id`。
- `BlockRenderer.tsx` 的 `ToolBlock` / `FileChanges`、`Markdown.tsx` 的 `CodeBlock` 也接入同一事件，收起 `open` / `showAll`。

### 3. `App.tsx` 滚动与工具栏

- 新增 `userScrolledAway` / `lastScrollTop` ref 与 `showScrollBtn` state；原来无条件的「每次渲染滚到底」改为仅当未离开底部时跟随。
- `onChatScroll()`（`chatScrollState`）、`scrollToBottom()`、`collapseAllBlocks()`（派发事件 + rAF 贴底）、`jumpToMessage(id)`（`[data-message-id]` + `scrollIntoView`）。
- `.chat-scroll` 挂 `onScroll`；右侧 `nav.msg-thumb-dock` 渲染 user 消息缩略；`showScrollBtn` 时显示 `.scroll-bottom-btn`；有消息时显示 `.collapse-all-btn`。
- 发送消息后强制贴底并重置 `userScrolledAway`；`newSession` / `selectSession` 一并重置。

### 4. 样式

`web/src/styles.css` 新增 `.scroll-bottom-btn`、`.collapse-all-btn`、`.msg-thumb-dock` / `.thumb-dock-inner` / `.thumb-item` / `.thumb-indicator` / `.thumb-preview`（默认 0.35 透明、hover 展开预览）与 `@keyframes bounce-down`；≤760px 媒体查询里按钮缩小、dock 隐藏。

### 5. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **177 项全过**（新增 `chat-scroll.test.mjs` 8 项；`markdown.test.mjs` 补 `./Motion` stub）。
- 生产构建：`vite build` 通过，`scroll-bottom-btn` / `thumb-dock-inner` 已进 `dist/renderer/assets/css/main-*.css`。
- 浏览器验收（dev 3000 + 后端 4567，会话「好无聊啊」）：滚到顶出现「回到底部」（1280×720 下 `right≈1255 / bottom≈609`），`.collapse-all-btn` 常驻；展开 3 个助手过程块后点折叠，`aria-expanded=true`、`[data-open=true]`、`.assistant-process-detail`、`.tool-detail`、`.reasoning-text` 全部归零且仍贴底；dock 列出 9 条 user 消息，点最后一条后 `scrollTop` 从 735 变 5116（底部），按钮消失；无 console error。

### 仍未迁移 / 待办（第 10 轮续）

- 旧 `Chat.vue` 头部「清空」按钮（清空本地消息 + 静默发 `/new`）：新前端用「新建会话 / 删除会话 / 会话管理」替代，未做同款按钮；后端命令注册表里没有 `new` 命令，需要后端先支持才能逐字对齐。
- 其余同上（Electron 桌面能力、Monaco 编辑、真实写操作端到端验收、需求池真实链路）。

## 第 11 轮：悬浮日志通知栈 / 流式进度条 / `bash_start` 自动开终端（2026-10-13）

对照旧 `Chat.vue` 模板 13–31 行（`streaming-bar`、`log-stack`）、样式 3201–3217 / 3505–3635 行、逻辑 1478–1510（`currentLogs` / `addLog` / `copyLog`）、1560–1566（`copy-success` / `app-notify` 监听）、2328–2332（SSE `log` 事件），以及 `App.vue` 370–374（`loopra:bash-start` → 打开右栏命令页签）补齐。

### 1. 纯逻辑 `web/src/chat-logs.ts`

- 常量：`CHAT_LOG_TIMEOUT_MS = 6000`、`CHAT_LOG_LIMIT = 6`。
- `chatLogLevel(raw)`：`DEBUG` 返回 `null`（旧版直接丢弃），`WARN` / `WARNING` → `warn`，`ERROR` / `FATAL` → `error`，其余 → `info`。
- `chatLogText(payload)`：依次取 `message` / `content` / `text`，字符串原样返回。
- `appendChatLog()`（前插 + 按 id 去重 + 截断到 6 条）、`removeChatLog()`。
- `chatLogCopyText()`（`[HH:mm:ss] text`，对齐旧 `copyLog()`）、`chatLogTime()`（条内展示用 `HH:mm:ss`）。

### 2. 组件 `web/src/components/ChatLogs.tsx`

- `useChatLogs()`：`logs` / `push(input, fallbackLevel)` / `dismiss(id)`；定时器存 `useRef(Map)`，每条 6 秒后自动移除；字符串输入用 `fallbackLevel`（window 事件没有级别），对象输入走 `chatLogLevel` 并丢弃 `DEBUG` / 空文本。
- `useEffect` 监听 window `copy-success`（前缀 `✅ `）与 `app-notify`，卸载时移除监听并清空所有定时器。
- 默认导出 `ChatLogs`：空栈返回 `null`；否则渲染 `.log-stack` + `.log-bar.log-<level>`（📋 图标、文本、时间、hover 显示的 `.log-bar-close`），点击整条调用 `onCopy(chatLogCopyText(entry))`，关闭按钮 `stopPropagation` 后 `onDismiss`。

### 3. `App.tsx` 接线

- `const chatLogs = useChatLogs();`；流式回调新增 `event.type === 'log'` → `chatLogs.push({ level, message, content })` 并 `return`（不落进消息块）；`event.type === 'tool_call' || 'sub_tool_call'` 且 `event.name === 'bash_start'` → `window.dispatchEvent(new CustomEvent('loopra:bash-start'))`。
- 新增 `useEffect` 监听 `loopra:bash-start` → `setTerminal(true)`（对齐旧版打开右栏命令页签）。
- `.main-content` 顶部：`generatingId` 或远端运行中时渲染 `.streaming-bar`（`role="status"`），其下渲染 `<ChatLogs logs onDismiss onCopy>`；复制成功再推一条 `✅ 日志已复制`，失败推 `ERROR` 提示。
- `web/src/backend.ts`：`StreamEvent` 补 `level?` / `message?`。

### 4. 样式 `web/src/styles.css`

`.streaming-bar` / `.streaming-bar-inner`（40% 宽渐变 + `streaming-slide` 1.4s 循环，`pointer-events:none`）、`@keyframes streaming-slide`、`.log-stack`（顶部悬浮、`z-index:100`、子项可点）、`.log-bar`（暗色玻璃、居中、`max-width: min(100%, 60rem)`、`log-bar-in` 进入动画）、`.log-bar.log-warn` / `.log-bar.log-error` 配色、`.log-bar-icon` / `-text` / `-time` / `-close`（默认透明、hover 显示）。

### 5. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **185 项全过**（新增 `chat-logs.test.mjs` 8 项：级别过滤 / 文本提取 / 前插去重截断 / 复制格式 / `copy-success`+`app-notify` 事件 / `DEBUG` 丢弃与关闭按钮 / 点击复制不消失 / 6 秒过期）。
- 生产构建：`vite build` 通过，`log-stack` / `streaming-bar-inner` 已进 `dist/renderer/assets/css/main-*.css`。
- 浏览器验收（dev 3000 + 后端 4567）：新建临时会话发送 `/compact` 后出现 `log-bar log-info`（`[compact] 无需折叠（历史不足以形成可折叠范围）`），6 秒后自动消失；再发一次后点击日志条，新出现 `✅ 日志已复制` 条；无 console error。验收会话已用后端 API 删除（`DELETE /api/sessions/<name>?workspaceHash=6b83120ffffd`），`GET /api/sessions` 回到「好无聊啊」「你好啊兄弟」两条。

### 仍未验证 / 待办（第 11 轮）

- `.streaming-bar` 的真实模型流式出现（本轮未触发真实生成，仅由代码路径与构建产物保证）。
- `loopra:bash-start` 自动打开右栏命令页签（需要真实 `bash_start` 工具调用，未触发）。
- 旧 `Chat.vue` 头部「清空」按钮：同第 10 轮，后端无 `new` 命令，暂以「新建会话 / 删除会话」替代。
- 其余同上（Electron 桌面能力、Monaco 编辑、需求池真实链路、真实写操作端到端验收）。

## 第 12 轮：链接悬停浮层 / 上下文折叠阈值 / 加密思考 / 附件上限 / 文件重命名与定位（2026-10-13）

第 11 轮后重新逐文件对照旧 `src/**`，确认并补齐 5 处仍缺的交互；公式渲染（KaTeX）其实早已在 `web/src/components/Markdown.tsx`，交接文档旧清单里那条已删除。

### 1. 链接悬停浮层（旧 `ChatMessage.vue` 120–140 / 368–475 / 969–1010）

- 新增 `web/src/link-popover.ts`：`LINK_POPOVER_HIDE_DELAY_MS = 150`、`normalizeActionUrl()`（照抄旧正则：只接受 http(s)，并按旧行为吃掉尾部标点）、`linkPopoverPosition()`（链接下方居中 + 视口夹取）。
- 新增 `web/src/components/LinkPopover.tsx`：`LinkPopoverProvider` + `useLinkPopover()`；`show(target)` 忽略 `data-file-path` 与非法 href，`scheduleHide()` 150ms 后关闭，浮层本体 `mouseenter` 取消关闭；「浏览器打开」优先走 `electronAPI.openExternal`，否则 `window.open`；Electron 下多一个「元素界面打开」走 `electronAPI.elementInspectorWindow.open`，缺失时回退派发 `loopra:open-in-element`。
- `Markdown.tsx`：外部链接加 `className="ai-link"` 并在根节点包一层 `LinkPopoverProvider`；工作区文件链接（`ai-file-link`）保持原有预览跳转，不显示浮层。
- 样式加在 `chat-blocks.css`（`.link-popover` / `-btn` / `link-popover-in`），沿用主题变量。

### 2. 上下文「折叠阈值 (80%)」（旧 `UsagePanel.vue` 76–93 / 441–472）

- `web/src/usage.ts`：新增 `FOLD_THRESHOLD_RATIO = 0.8` 与 `foldThreshold(limit)`（`Math.floor(limit * 0.8)`，非法窗口返回 0）。
- `Composer.tsx` 上下文弹层：新增 `.context-gauge` 进度条（渐变填充 + 80% 阈值刻度，`title="折叠阈值 (80%)"`、`aria-label` 带阈值）、`当前 / 窗口` 刻度行、`折叠阈值: N (80%)` 文案；占用百分比按旧版 high(≥80%) / medium(≥50%) / low 着色；原来的分段构成条继续保留在下方。
- `composer.css`：`.context-gauge` / `.context-gauge-fill` / `.context-gauge-scale` / `.context-threshold-note` / `.context-bar-threshold`（`#e4b467`，对齐旧 `--yellow`）。

### 3. 加密思考块（旧 `BlockRenderer.vue` 22–42、`chatHistory.js` 11–19 / 211–213）

- 后端**仍然会发** `reasoning_started`（`SseEmitter.sendReasoningStarted()` ← `SseAgentOutput.onReasoningStarted()`），新前端此前没处理。
- `chat.ts`：`ChatBlock` 增加 `reasoning_started`（空 content）。
- `backend.ts`：`applyEvent` 收到 `reasoning_started` 时在末尾压入占位块（同类型不重复压），随后第一个 `reasoning` 增量把它升级成普通思考块；`stream_reset` 一并回滚该占位块。新增 `hasEncryptedReasoning()`（照抄旧判断 `type === 'reasoning' && encrypted_content`），`historyMessages()` 对 `response_reasoning` / `responseReasoning` 命中时补一个 `reasoning_started` 块。
- `BlockRenderer.tsx`：`reasoning_started` 复用「思考」折叠样式，展开后固定显示 `加密思考`（`role="status"`）。

### 4. 附件数量上限（旧 `ChatInput.vue` 1148–1151 / 1425–1427 / 1448–1455）

- `documents.ts`：新增 `MAX_IMAGE_COUNT = 10`、`MAX_UPLOAD_FILES = 10` 与 `attachmentLimitReached(imageCount, docCount, kind)`（图片与文档各自计数）。
- `Composer.tsx` `addFiles()`：按已有附件算出图片/文档数量，超限时逐条跳过并提示 `图片数量已达上限（10 张）` / `上传文件数量已达上限（10 个）`（同一批只提示一次），成功解析后再累加计数。粘贴图片与拖拽/选择文件走同一条路径。

### 5. 文件「重命名 / 在文件管理器中显示」（旧 `FileExplorer.vue` 69–105 / 289–311 / 500–520）

- 后端 `WorkspaceFileController` 只有 `tree/search/delete/paste`，**没有** rename/reveal 接口；旧版这两项走 Electron IPC（`window.electronAPI.fileExplorer.rename` / `openFolder`）。
- 新增 `web/src/desktop-files.ts`：`desktopFileBridge()`、`canRenameFiles()`、`canRevealFiles()`、`invalidFileName()`（非空、非 `.`/`..`、不含分隔符）、`baseName()`、`renamedPath()`。
- `FilesPanel.tsx` 右键菜单在探测到桥时才显示「重命名」「在文件管理器中显示」：重命名就地展开输入框（Enter 提交 / Escape 取消 / 失焦提交），成功后同步树、展开集合、搜索结果与预览路径（含子路径前缀），失败/非法名走顶部提示；「在文件管理器中显示」调用 `openFolder` 并回报失败原因。浏览器版保持原有菜单，并在代码注释里写明这是设计取舍。
- `workbench.css`：`.workspace-tree-entry.editing` / `.tree-rename-input`；右键菜单的视口夹取从 `-150` 提到 `-210`（菜单变高）。

### 6. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **203 项全过**。新增 `usage.test.mjs` 3 项、`link-popover.test.mjs` 6 项、`desktop-files.test.mjs` 3 项；扩写 `documents.test.mjs`（附件上限）、`backend.test.mjs`（`reasoning_started` + `hasEncryptedReasoning`）、`files-panel.test.mjs`（无桥隐藏 / 有桥重命名与定位）、`markdown.test.mjs`（真实 LinkPopover 悬停）、`chat-logs.test.mjs`（`log` 事件级别）。
- 生产构建：`vite build` 通过，`link-popover` / `context-bar-threshold` / `tree-rename-input` 已进 `dist/renderer/assets/css/main-*.css`。
- 浏览器验收（dev 3000 + 后端 4567）：上下文弹层显示 `420 / 512K`、`0.1%`、`折叠阈值: 409,600 (80%)`、刻度线实测落在 79.7%（`#e4b467`），`aria-label="上下文占用 0.1%，折叠阈值 80%"`；临时会话里造了带 Markdown 链接的助手消息，`a.ai-link` 正常渲染（href 与裸链接都在）。验收会话 `zz-hover-check` 已通过后端 API 删除。

### 仍未验证 / 待办（第 12 轮）

- 链接浮层的**真实悬停**未在浏览器里跑（IAB 的 `evaluate` 沙箱没有 `Event`/`dispatchEvent`，locator 也没有 `hover`）；改由 `link-popover.test.mjs` + `markdown.test.mjs` 在 JSDOM 里挂载真实组件断言浮层出现与两个按钮的调用路径。桌面端「元素界面打开」仍走旧 Vue 窗口（`entry-routing.js` 把 `elementInspector` 指向 Vue）。
- 「在文件管理器中显示」「重命名」的**真实 Electron IPC** 未跑（开发环境是浏览器），只有单测用 stub 桥验证；Web 版没有后端接口，属设计取舍。
- 其余同上（Electron 桌面能力、Monaco 编辑、需求池真实链路、真实写操作端到端验收、`.streaming-bar` 真实流出、`loopra:bash-start` 自动开终端）。


## 第 13 轮：Goal/清单浮层 / 会话批量删除 / 本地斜杠指令扩充（2026-10-13）

### 1. Goal / 清单进度浮层（旧 `ChatInput.vue` `.workflow-float` + `GoalSteps.vue` / `ChecklistSteps.vue`）

- `web/src/components/SessionDetails.tsx`：新增 `SessionProgress`，用 `ProgressCard`（`<details>` 可折叠）同时渲染 Goal 与清单；状态文案映射 `progressStatusText` / `progressStepStatusText`（清单 `RUNNING` → 进行中）。
- `isCurrent` 复刻旧 `GoalSteps.isCurrent`（IN_PROGRESS/RUNNING 优先，否则取首个 PENDING）；清单用 `currentStepIndex`。
- 展示进度条、步骤点、HITL/FORK 标签、blocked/verify/summary 文案。
- `web/src/workbench.css`：旧的 `.session-progress` 样式整体替换为 `.session-progress-card` / `.progress-*`（主题变量 + 深色覆盖 + 窄屏回退）。
- 数据来源：`GET /sessions/{name}/goal`、`GET /sessions/{name}/checklist?workspaceHash=`。
- 单测 `web/tests/session-progress.test.mjs` 6 项全过。浏览器实测：临时 Goal+清单数据显示「补齐前端迁移剩余功能 | 阻塞 | 1/4」「发布前检查 | 进行中 | 第 2/3 步」，展开后进度条 25% / 66.6667%、当前步骤、「验证命令:」、`分支`/`人工审批` 标签均正确（临时数据已删除）。

### 2. 会话批量删除（旧 `DesktopHome.vue` 多选 + `DesktopShell.performDeleteSessions`）

- `web/src/components/SessionsManager.tsx`：新增全选/取消全选、`删除选中 (N)` 按钮、卡片复选框、`removeSelected()`（逐个 `DELETE /sessions/{name}`）；成功/部分失败分别提示，失败项保留选中。
- `web/src/sessions.css`：`.sessions-manager-card.selected`、`.sessions-manager-check`。
- `web/tests/sessions-manager.test.mjs` 扩到 10 项全过（含部分失败场景）。浏览器实测：勾选 2 项后按钮变 `删除选中 (2)`，弹窗文案 `nihao、好无聊啊 将被永久删除，无法恢复。`；未真实执行删除（点了取消）。

### 3. 本地斜杠指令扩充（旧 `ChatInput.vue` `defaultSlashCmds`）

- `web/src/composer.ts`：新增纯函数 `localSlashCommands(actions)`，提供 `/new /export /sessions /continue /skills /terminal /help`。
- `Composer.tsx` 改用它；`App.tsx` 传入 `onExport`（`chatExportText` + `downloadText`）与 `onSessions`（打开会话管理）。
- 单测 `composer-server.test.mjs` 新增 1 项。浏览器实测：输入 `/` 显示 7 个本地指令 + 服务端指令（`/agree /compact /deny /goal /hitl /init /plugin` 等）。

### 4. 恢复 `GET /api/agent/prompt`（后端重构删除了端点，前端与旧版都在调用）

- 后端 commit `d9722354` 删除了 `/api/agent/prompt` 与 `PromptDTO`，旧版 `legacy.html` 的「提示词」按钮和新版 `SessionDetails.tsx` 的「实际系统提示词」都还在调用，此前一律 500。
- 新增 `loopra/src/main/java/site/sorghum/loopra/web/model/PromptDTO.java`（`record PromptDTO(String content, int length)`）。
- `AgentLoop.effectiveSystemPrompt()`：用 `cutinEngine.newContext("prompt-preview", Map.of(), workingDirectory())` + `promptRegistry.assemble(...)` 拿到切片聚合结果；`LoopraAgent.effectiveSystemPrompt()` 转发；`AgentService.getSystemPrompt(workspacePath, sessionName)` 组装 DTO；`AgentController` 新增 `GET /api/agent/prompt`（`workspaceHash` / `sessionName` 可选）。
- 实测：`GET /api/agent/prompt?workspaceHash=6b83120ffffd&sessionName=loopra-20261010205228` → 200，`data.length` 3535，含「工具协作约定」「环境信息」等全部切片。

### 5. 修复用户级 `~/.loopra/loopra.md` 不再进入真实 system prompt

- 回归原因：`ToolSystemInitializer.initializePluginized()` 忽略 `defaultSystemPrompt`（只建空前缀），真实 system 由 `LoopraPromptPlugin.registerBuiltIns()` 的切片拼装，而切片里**没有**用户级 `loopra.md`；`AgentService.loadDefaultSystemPrompt()` 仍在读文件但结果被丢弃，设置页保存的系统提示词实际不生效。
- `LoopraPromptPlugin.registerBuiltIns()` 新增 `user-prompt` 切片（order 200，紧跟 core-identity、早于 skill-contract），非空才贡献；读取失败/文件不存在返回 `null`，不影响其他切片。`PromptSlice` 的 order 约定注释同步更新。
- 验证：`PUT /api/loopra-md` 写入临时标记 → `GET /api/agent/prompt` 返回 `MARKER FOUND`，聚合顺序 core → user-prompt → skill → env → tool → doc；随后 `PUT` 空内容清回，标记消失（未留用户数据）。
- 后端测试：`PluginPromptToolPluginTest` + `AgentLoopPromptFreezeTest` 共 7 项全过。

### 6. 修复「实际系统提示词」标签页渲染对象导致整页崩溃

- 新端点返回 `{ content, length }`，而 `SessionDetails.tsx` 把它当字符串渲染 `<pre>{prompt.data}</pre>`，React 抛 “Objects are not valid as a React child” 并卸载整个 `#root`（实测页面变空白）。
- 新增 `web/src/session-prompt.ts` 的 `promptText(value)`：兼容 `{ content }` 与纯字符串，其余一律返回 `''`；`SessionDetails.tsx` 改用它。
- 新增 `web/tests/session-prompt.test.mjs` 3 项；`session-progress.test.mjs` 的模块替换表补 `../session-prompt` stub。
- 浏览器复验：会话 → 会话选项 → 原始记录与快照 → 实际系统提示词，`pre.session-raw` 长度 3535，页面 `#root` 未卸载。

### 7. 补「清空对话」（旧 `Chat.vue` 头部按钮 + `ChatInput` `/clear`）

- `web/src/composer.ts` 的 `localSlashCommands` 新增 `/clear`，`LocalCommandActions` 增加 `onClear`；`Composer.tsx` 透传。
- `web/src/App.tsx` 新增 `clearChat()`：生成中拒绝并提示，否则在当前工作区新建空白会话（后端 `/new` 命令已删除，语义等价）。会话选项菜单（`.session-menu`）新增「清空当前对话」。
- `web/tests/composer-server.test.mjs` 更新为 8 个本地指令。

### 8. 上下文弹层补费用明细（旧 `UsagePanel.vue` 115–141）

- `web/src/usage.ts`：`UsageDTO` 增加 `inputCost` / `cacheCost` / `outputCost`，`UsageMetrics` 同步透传。
- `Composer.tsx` 免责声明行在 `hasPrice` 时展示「输入 ¥x · 缓存 ¥x · 输出 ¥x」。
- `web/tests/usage.test.mjs` 增加三项明细断言。

### 9. 删除误导性死代码 + 修正帮助页指令表

- 删除 `BackendSettings.tsx` 中已无引用的 `BackendResources`（含「新增、编辑及高级配置可在 legacy.html 管理」提示），清理相关 imports。
- `web/src/help.ts`：`helpCommands` 按 `GET /api/agent/commands` + `localSlashCommands` 的真实集合重写（新增 `/clear /export /continue /plan /execute /agree /deny /plugin /skills /terminal`，删除后端已不存在的 `/retry /rewind /load /exit`）；`helpSections.commands` 关键词与 `helpEndpoints` 同步（补 `/api/chat/abort`、`/api/agent/commands`、`/api/agent/prompt`、`DELETE /api/sessions/cleanup`，删 `/api/chat`、`/api/agent/retry`、`/api/agent/rewind`、`/api/agent/compact`）。
- `web/tests/help.test.mjs` 新增 1 项指令表断言，`searchHelp('rewind')` 用例改为 `compact` / `/api/agent/prompt`。

### 10. 本轮验证

- 类型检查：`tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **218 项全过**（新增 `session-progress.test.mjs` 6 项、`session-prompt.test.mjs` 3 项、`help.test.mjs` 1 项，`sessions-manager.test.mjs` 扩 3 项，`composer-server.test.mjs` 扩 1 项）。
- 后端：`mvn -o -pl loopra -am test -Dtest=PluginPromptToolPluginTest,AgentLoopPromptFreezeTest` 7 项全过；`mvn -o -pl loopra -am compile -DskipTests` 通过。
- 生产构建：`vite build` 通过（仅剩既有 chunk 体积警告）。
- 浏览器验收（dev 3000 + 后端 4567，会话「好无聊啊」）：
  - 会话选项菜单出现「清空当前对话」；输入 `/clear` 出现指令建议，回车后 `.chat-content .msg` 归零、输入框清空、提示「已新建空白会话」。
  - 上下文弹层切到服务端统计：`33,470 / 512K`、`6.5%`，五段构成（系统指令/工具定义/用户消息/助手消息/工具结果），免责声明为「服务端统计：输入 396,279 · 输出 7,357 · 费用 ¥0.00（输入 ¥0.0000 · 缓存 ¥0.0000 · 输出 ¥0.0000） · 缓存命中 79.0%」。
- 浏览器 console 无 error。

### 11. 设置页「浏览器」集成取代 legacy.html 跳转（第 13 轮续）

- 背景：设置 → 工具与集成原本只有一句「也可在 legacy.html 管理」，是 `web/src` 中最后一处指向旧前端的引用。
- 后端新增 `GET /api/system/browser-bridge`（`SystemController.browserBridgeStatus()`）：返回 `{ registered, address }`，`address` 取自 `AiBrowserBridgeService.getAddress()`，桌面端未登记时为 `""`。用 `mvn -o -pl loopra -am compile -DskipTests` 重新编译并重启后实测返回 `200 {"success":true,"data":{"registered":false,"address":""}}`。
- 前端新增 `web/src/components/BrowserSettings.tsx`：只读展示桥接状态（`useRemote` 拉 `/system/browser-bridge` + `/tools`）、过滤 `browser_*` 工具数并逐条列出只读/写入/停用标记，含「刷新」按钮与 `BRIDGE_UNAVAILABLE` 说明。`Settings.tsx` 用 `<BrowserSettings api={api} />` 替换原 legacy 提示，`web/src` 内已无 `legacy.html` 引用。
- 新增 `web/tests/browser-settings.test.mjs` 3 项（未连接 + 工具计数过滤、已连接地址、只读/停用标记）。
- 浏览器验收：设置 → 工具与集成 → 集成类型「浏览器」，显示「未连接（AI 浏览器仅在桌面端可用）」「8 个」及 8 个 `browser_*` 工具说明。

### 12. 长会话消息虚拟滚动（第 13 轮续）

- 缺口：旧 `views/Chat.vue` 对长会话做窗口化渲染（`virtualWindow`，阈值 60 条、估算高度 320px、overscan 1200px，配 `.virtual-spacer` 与 `.virtual-message-item`），新 `Conversation.tsx` 此前一次性挂载全部消息。
- 新增 `web/src/chat-window.ts` 纯逻辑：`messageOffsets(heights)`（未测量行回退 `ESTIMATED_MESSAGE_HEIGHT`）与 `virtualMessageWindow(heights, scrollTop, viewportHeight)`（≤60 条时 `start=0/end=total` 且两个 spacer 为 0，短会话行为与普通列表完全一致）。常量 `ESTIMATED_MESSAGE_HEIGHT=320` / `VIRTUAL_OVERSCAN=1200` / `VIRTUALIZATION_THRESHOLD=60` 对齐旧实现。
- `Conversation.tsx`：`Messages` 新增 `scrollRef`（滚动容器）与 `offsetsRef`（回传 `view.offsets`）两个可选 prop；仅当消息数 > 60 时挂 `scroll`/`ResizeObserver` 监听并在窗口化分支用 `.virtual-message-item` 包裹每条消息、前后补 `.virtual-spacer`。共享 `ResizeObserver` 记录真实高度，仅在高度变化 >0.5px 时重渲染，避免抖动。
- `App.tsx`：新增 `messageOffsets` ref 并传给 `Messages`；`jumpToMessage` 在目标未挂载（虚拟窗口外）时回退 `scrollTo({ top: offsets[index] })`，缩略图 dock 仍可跳转任意历史消息。
- `web/src/styles.css`：新增 `.virtual-message-item { display: flow-root }`（把 `.msg` 的 `margin-bottom` 收进被测高度）与 `.virtual-spacer { width: 100% }`。
- 测试：`web/tests/chat-window.test.mjs` 4 项（短会话零 spacer、估算回退、中段窗口拼回完整高度、超高视口保留尾部）；`web/tests/chat-scroll.test.mjs` 新增 3 项（80 条只挂 4 条 + 底部 spacer 高度、短会话无 spacer/包裹、`offsetsRef` 长度为 n+1），并补 `ResizeObserver` stub 与 `../chat-window` 模块映射。
- 浏览器回归：dev 3000 打开「nihao」会话（1 条消息），`.virtual-spacer`/`.virtual-message-item` 均为 0，消息与缩略图 dock 正常。**未做** >60 条的浏览器实测（当前工作区最长会话仅 13 条），长会话路径由单测覆盖。

### 13. 隔离后端 + 真实浏览器验收（第 13 轮续，写操作与虚拟滚动）

为做真实写操作/长会话验收，按 `docs/testing-isolation.md` 另起隔离后端 `http://127.0.0.1:4568`
（`-Duser.home=C:\Users\15614\Documents\Code\loopra\.cache\iso-home`，工作目录同该目录以隔离日志），
并从真实 `~/.loopra` 复制 `config.json`（含 API key）/`model_meta.json`/`sub-agents.json`/`mcp-servers.json`/`loopra.md`。
隔离数据目录为 `.cache/iso-home/.loopra/workspace/{hash}/sessions/*.jsonl`，hash 为项目路径 MD5 前 12 位（本仓库 = `0a45e3813771`）。
通过设置 → 连接与帮助 → 服务器 → 后端 API 地址在真实后端 `4567` 与隔离后端 `4568` 之间切换，验收后已切回 `3000`（同源代理到 `4567`）。

- **长会话虚拟滚动真实浏览器验收**：在隔离后端造 80 条消息的会话「隔离长会话」，打开后仅挂载 24–25 个 `.virtual-message-item`；`scrollHeight` 18962（顶部 spacer 16966px），跳转到中段后 `scrollHeight` 6560（spacer 4460.8px）；缩略图 dock 40 项，点击首个 dock 项跳到未挂载的 `history-0` 并正确渲染 25 条。**结论：虚拟滚动含 dock 回退路径（`jumpToMessage` 对未挂载目标的 `scrollTo({top: offsets[index]})` 回退）在真实浏览器可用。**
- **`DELETE /api/sessions/cleanup` 真实写操作验收**：在隔离目录造 `iso-old.jsonl`（mtime 60 天前）→ 设置 → 工作区与数据 → 项目 → 「清理过期会话」（近 30 天）→ 确认后 `iso-old` 被删、`iso-long` 保留（API 与磁盘双重确认）。
- **删除会话真实写操作验收**：造 `iso-del` → 侧栏「删除 待删除会话」→ 弹窗「删除 待删除会话 及其在 Loopra 服务端的记录？此操作不可恢复。」→ 确认后列表与磁盘均只剩 `iso-long`。

本轮新证据：`/sessions/cleanup` 与单会话删除两条真实写路径已在隔离后端 + 真实浏览器端到端跑通（此前仅有单测断言端点与载荷）。

### 14. `/continue` 语义对齐 + 切换后端清空 TPS（第 13 轮续）

- **`/continue` 行为对齐**：旧 `Chat.vue` 的 `continueChat()` 把输入框设为 `'/continue'` 再发送，由后端 `ContinueCommand` 处理——**不追加用户消息**、无 HITL 时直接复用上下文继续推理、有 HITL 待审批时等同 `/agree` 放行。新前端此前把「继续生成」按钮/本地 `/continue` 指令实现为发送 `请继续上一次回复，补充后续步骤和注意事项。` 文本，会追加一条真实用户消息，且 HITL 待审批时语义错误。现 `App.tsx` 的 `onContinue` 改为发送字面量 `/continue`，与旧版一致（`onSend`/`/continue` 本地指令共用该回调）。
- **切换后端清空 tokens/s**：`liveSpeed` 原来只在 `newSession`/`selectSession` 清空，切换服务器后首页合成器仍会显示上一个项目的「平均 x t/s · 实时 y t/s」徽标。新增 `useEffect(() => setLiveSpeed(undefined), [server])`。

### 15. `.streaming-bar` / tokens/s 真实流出验收（真实模型，第 13 轮续）

按 `docs/testing-isolation.md` 在隔离后端 `4568`（复制真实 `~/.loopra/config.json`，含可用 API key）上用真实模型跑通一次完整流式回复：

- 设置 → 连接与帮助 → 服务器 → 后端 API 地址 切到 `http://127.0.0.1:4568` → 新建会话 → 发送「请用三句话介绍你自己」。
- 观测：`.streaming-bar`（`aria-label="会话正在执行"`）在发送后 **0.5s** 出现；`.composer-tps` 徽标在 **4.8s** 出现并显示「42.9 t/s」；随后 `.streaming-bar` 消失，助手消息渲染完成（「用时 3秒」+ 正文），上下文弹层显示「生成速度 … · 已生成 131 tokens」、`平均 42.9 t/s · 实时 652 t/s · 131 tokens`。
- 结论：**`.streaming-bar`、`token_speed` 实时/平均速率徽标、真实流式正文渲染已在真实模型下端到端验证**（此前仅有单测覆盖）。验收后已切回 `http://127.0.0.1:3000`，并删除隔离后端上创建的验收会话。

### 16. `loopra:bash-start` 自动开终端：第 13 轮初次未通过（复测通过见第 17 节）

- 前端接线保持不变（与旧 `App.vue` 一致）：SSE `tool_call`/`sub_tool_call` 且 `event.name === 'bash_start'` → `window.dispatchEvent(new CustomEvent('loopra:bash-start'))` → `useEffect` 监听并 `setTerminal(true)`。
- 在隔离后端 `4568` 发送「请调用 bash_start 工具在后台启动命令 sleep 180…」，模型**确实返回了** `bash_start` 工具调用（原始日志 `response.output_item.done` 中 `name":"bash_start"`，参数 `{"command":"sleep 180","yield_time_ms":1000,"hard_timeout_ms":200000}`，`stop_reason":"tool_calls"`）。
- 但**隔离后端在 `response.completed` 后没有继续执行工具**：日志在 `[raw] provider 原始响应体：` 处停止（`04:58:51`），`GET /api/agent/session-status` 立即返回 `running:false`，`GET /api/agent/bash-sessions` 为空，会话 `.jsonl` 只写入了一条 user 消息，前端因此也没有收到 `tool_call` 事件、终端未自动打开（前端行为正确，无 console error）。
- 该隔离实例已包含本轮最新编译产物（`/api/system/browser-bridge` 可用），故不是「跑的是旧 class」；真实后端 `4567` 的历史会话里存在大量 `role=tool` 记录（含 `bash`/`npm test` 等），说明常规工具调用链路正常。**此隔离环境下的 `bash_start` 未继续执行的原因未定位，属后端/环境问题，本轮未再追**；`loopra:bash-start` 的浏览器端到端验收仍待补（建议在真实后端 + 无快照副作用的 `defaultWorkSpace` 里用真实模型复测）。

### 17. 第 14 轮（2026-10-13）：HITL `choice` 澄清 + 浏览器全量验收 + `bash-start` 端到端复测通过

#### 17.1 HITL `choice` 事件：已实现，不是缺口（更正上轮交接摘要）

- 上轮交接摘要称「新前端 `backend.ts` `applyEvent` 完全忽略 `event.type === 'choice'`，HITL 审批会卡住」——**该结论不准确/已过时**。现码：
  - `web/src/backend.ts` 的 `applyEvent` 有显式 `choice` 分支：`else if (event.type === 'choice' && event.options?.length) blocks.push({ type: 'choice', ... })`；`sub_choice` 亦单独处理。
  - `web/src/chat.ts` 有 `{ type: 'choice', ... }` 块类型（且为终态响应边界）。
  - `web/src/components/BlockRenderer.tsx` 的 `ChoiceBlock` 渲染选项按钮（`onChoice(value, subId)`）。
  - `web/src/App.tsx` 的 `chooseOption`：子代理 → `POST /chat/sub-hitl/{subId}`；主代理 → 填入输入框。
  - 以上代码在 HEAD 提交中即存在（`git diff` 无 `choice` 变更），属早已迁移完成的能力。
- 与旧 `Chat.vue sendChoice` 的**交互差异（既定设计，非缺失功能）**：
  - 旧版点击选项后**立即发送**（`inputText.value = value; sendMessage()`），并移除本轮被拦截、无 `result` 的 `tool_call` 卡；新版点击后**填入输入框**，由用户确认后再发送，且提供「重新选择」。
  - 复测证据：隔离后端 `c38b6c03c501` 用 `curl` 触发 HITL，SSE 序列为 `snapshot → log → reasoning_started → token_speed → reasoning → token_speed → choice → done`，**`choice` 前没有 `tool_call` 事件**。故新版「不删除被拦截 tool_call」在真实 HITL 流中是**无操作**，不会留下悬挂的「执行中」工具卡。
  - 结论：HITL 审批链路可用，仅交互细节不同；保留新版设计，不再改动。

#### 17.2 第 14 轮验证基线

- `cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- `node --test web/tests/*.test.mjs` → **228 全过**。
- `vite build` 通过（仅既有 chunk 体积警告；`monaco` 等大块属旧 Vue 高级控制台产物）。
- 浏览器验收（dev `3000` → 真实后端 `4567`，IAB + Playwright 定位器）：逐页打开并断言渲染，全程 **0 条 console error / warning**：
  - 设置分类：通用 / 模型服务 / 智能体 / 工具与集成（工具 46 项、技能、插件、拓展包、MCP、语言服务、OpenAPI、浏览器）/ 工作区与数据 / 连接与帮助。
  - 侧栏浮层：需求池（对话框 `aria-label=需求池`，`0 条需求` + 待执行/执行中/已完成/已失败分栏）、帮助中心、会话管理、搜索。
  - 右侧工作区面板（改动面板）：文件树 / Git（`master · 1 个改动`、暂存、AI 生成说明、提交）/ 定时 / 子代理 / 能力（项目 Skill/MCP 计数）/ 环境。
  - 后台命令面板（打开终端）：`后台进程`。
  - 输入栏浮层：上下文用量（`420 / 512K`、`折叠阈值 409,600 (80%)`）、常用要求、添加附件或工具（工具/上传文件/计划模式/关联项目/技能/权限模式/打开终端）。
  - 「隧道配置请求格式」确认正确：`web/src/integration.ts` 的 `tunnelConfigPayload` 仅发 `{ executablePath }`（旧 `Settings.vue` 也仅绑定 `mcpTunnelConfig.executablePath`），不会误存只读的 `configuredExecutablePath`。

#### 17.3 `loopra:bash-start` 自动开终端：端到端复测**通过**

- 环境：隔离后端 `4568` + 真实模型；新前端 dev `3000` 经「设置 → 连接与帮助 → 服务器」切到 `http://127.0.0.1:4568`（`4568` 对 `Origin http://127.0.0.1:3000` 返回 CORS 允许头，可跨源直连）。为让工具真正执行，先在 `4568` 将 `bash_start` 设为自动放行（`POST /api/tools/bash_start/auto-toggle`）。
- 复测：输入「请调用 bash_start 工具在后台启动命令 sleep 60…」。模型调用 `bash_start`（第一次 `sleep 60` 在 Windows cmd 下 `exit_code=1`；第二次 `ping -n 61 127.0.0.1 > nul` 成功），后端返回 `tool_call` → **前端自动打开右侧「后台进程」面板**，显示「1 个运行中 · 共 1 个进程 / 停止进程 / `ping -n 61 127.0.0.1 > nul` · 运行中 · 已运行 N 秒」。
- 结论：`loopra:bash-start` → 自动打开终端**已在真实模型 + 真实 `bash_start` 下端到端验证通过**。上轮「未通过」系该隔离实例当时 `bash_start` 未自动放行（被 HITL 拦截或未继续执行），**非前端问题**。
- 收尾：已用「停止进程」结束后台会话（`GET /api/agent/bash-sessions` 为空）；已把 dev 应用服务器地址**改回** `http://127.0.0.1:3000`；已删除隔离后端上本轮创建的测试会话（`loopra-20261013052028`、`hitl-probe-051122`、`loopra-20261013050752`）。隔离后端 `4568`（PID 46596）仍按上一轮约定保留运行。

### 仍未迁移 / 待办（第 14 轮更新）

- 旧 `Chat.vue` 头部「清空」按钮已按「新建空白会话」等价实现（见第 7 节）；若后端日后恢复真正的 `/new` 就地清空，需再对齐。
- 用量面板费用明细已透传后端 `inputCost/cacheCost/outputCost`；但当前模型未配置价格，实测三项均为 0，尚未用真实计费模型验证非零金额。
- 长会话虚拟滚动已在隔离后端 + 真实浏览器验收（见第 13 节）。
- 真实写操作端到端验收：`/sessions/cleanup`、删除会话已验收（见第 13 节）；删文件/目录、长粘贴保存、排队消息引导、文档上传仍未真实验收。
- `.streaming-bar` / tokens/s 真实流出已验收（见第 15 节）；`loopra:bash-start` 自动开终端已在隔离后端 + 真实模型下端到端验证通过（见第 17.3 节）。
- HITL `choice` 已实现，非缺口；与旧版仅「点击即发 vs 填入草稿」的交互差异，属既定设计（见第 17.1 节）。
- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`）、Monaco 编辑、`SetupScreen.vue`、`StatusBar.vue`、`Home.vue` 视觉、`NotFound.vue`、独立 `Tools.vue`（设计取舍）。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue。
- 隔离后端 `4568`（PID 46596）仍在运行，`.cache/iso-home` 里含真实 `config.json`（API key）；收尾时 `Stop-Process -Id 46596` 并按需删除该目录。

## 第 15 轮（2026-10-13 续）：社区链接 / 欢迎页项目管理 / 排队消息端到端验收 + 隔离环境收尾

### 1. 开源主页链接（旧 `components/TitleBar.vue` 的 `.tb-community`）

- 旧 web 控制台的标题栏（`TitleBar.vue`，非桌面端也渲染）左侧有「Gitee / GitHub Star」两个外链按钮；新 React 工作台没有标题栏，此前没有任何社区入口。
- `web/src/update-scripts.ts`：新增 `GITHUB_HOME_URL = 'https://github.com/ezdemo/loopra'`（`GITEE_HOME_URL` 早已存在）。
- `web/src/components/Settings.tsx` 的「关于」标签页在「Loopra Web 服务」上方新增「开源主页」行，用 NextUI 按钮 + lucide `Star` 图标打开 Gitee / GitHub 主页（`window.open(..., '_blank', 'noreferrer')`，与旧版 `openExternal` 语义一致）。样式 `.about-community` 加在 `web/src/settings.css`。
- 浏览器实测：设置 → 连接与帮助 → 关于，出现「开源主页 · 在 Gitee 或 GitHub 上关注 Loopra，欢迎点个 Star」+ Gitee/GitHub 两个按钮，`0` console error。

### 2. 欢迎页「项目管理」入口（旧 `ChatInput` 欢迎态 + `WorkspacePickerModal`）

- 旧欢迎页的工作区下拉里有一行「项目管理」按钮（`openWelcomeWorkspaceManager` → 打开 `WorkspacePickerModal`，可新增/切换/排序/移除项目）。
- `web/src/App.tsx` 欢迎态的 `.workspace-menu` 弹层：在项目列表下方补 `hr` + 「管理项目」按钮（lucide `FolderPlus`），点击调用已有的 `openSettings('项目')` 进入设置 → 项目（新增/排序/移除/清空/清理过期会话都在那里）。空项目时补「暂无可用项目」占位。
- 浏览器实测：新建会话 → 打开工作区下拉，菜单出现「管理项目」；点击后设置面板打开在「项目」页（含「添加本地项目」「清理过期会话」）。

### 3. 排队消息「结束后自动发送」端到端验收（真实模型）

- 环境：隔离后端 `4568`（复制真实 `~/.loopra/config.json`）+ 新前端 dev `3000` 经「设置 → 连接与帮助 → 服务器」切到 `http://127.0.0.1:4568`。
- 步骤：在欢迎页发送一个长散文（生成较久）→ SSE 流式期间发送按钮变为「加入队列」→ 输入第二条「排队消息端到端验证：请只回复 QUEUE-OK。」并点「加入队列」→ 出现队列面板 `排队 1 条 · 当前回复结束后自动发送`（含「引导」按钮）→ 第一条回复结束后队列自动清空，排队内容**作为独立用户消息发出**并收到「QUEUE-OK」回复（`.msg` 依次为：散文、散文回复、长文、长文回复、排队消息、QUEUE-OK 回复）。
- 结论：**排队消息真实发送链路（入队 → 当前流结束 → 自动发送 → 收到回复）在真实模型下端到端验证通过**（此前仅有 `message-queue.test.mjs` 单测）。

### 4. 长粘贴保存（`POST /files/paste`）后端契约验收

- IAB 的 `locator.evaluate` 沙箱里 `Event`/`ClipboardEvent`/`DataTransfer` 全部 `undefined`，`tab.paste` 走 AX 输入、无法触发真实 `ClipboardEvent`，因此**无法在浏览器里模拟长粘贴**（与上几轮结论一致）。
- 改为直接验证后端契约：`POST http://127.0.0.1:4568/api/files/paste {workspaceHash, content(>8000 字符)}` 返回 `{ success:true, data:{ name, path:'.loopra/paste/<name>.txt', chars, bytes } }`，磁盘上 `.loopra/paste/<name>.txt` 已写入 9028 字节。前端 `Composer.handlePaste` 正是读取 `saved.path` 并加进 `context.files`，字段一致，代码路径与 `web/tests/composer-server.test.mjs`/`documents.test.mjs` 覆盖的解析分支吻合。

### 5. 本轮验证与收尾

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **228 项全过**。
- 生产构建：`vite build` 通过（仅既有 chunk 体积警告；`monaco` 等大块属旧 Vue 控制台产物）。
- 浏览器 console：新增 2 处 UI（社区链接、欢迎页项目管理）+ 排队消息流程全程 `0` error / `0` warning。
- 收尾（已完成）：把 dev 应用服务器地址改回 `http://127.0.0.1:3000`（标题栏实测 `http://127.0.0.1:3000 · v26.9.91`）；`GET /api/agent/bash-sessions` 为空；`Stop-Process -Id 46596` 停掉隔离后端，`.cache/iso-home`（含真实 API key 的 `config.json` 与全部验收会话）已整目录删除。

### 6. 仍未迁移 / 待办（第 15 轮）

- 长粘贴保存仍只有**后端契约 + 前端代码/单测**保证，浏览器无法模拟真实 `ClipboardEvent`；如需再验，只能在 Electron/真实桌面里粘贴。
- `.chat` 输入栏的「上传文件 / 大段粘贴」在旧版是**独立分组 + 每组「清除」按钮**（`clearUploadedFiles` / `clearLargePastes`），新版统一并入 `context.files` chip 行（逐条移除），未再补分组与「全部清除」，属交互简化。
- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`（仅桌面端渲染））、Monaco 文件编辑（后端无写文件接口）、`SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 旧视觉：设计取舍，未迁移。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue；需求池已在新工作台内提供侧栏入口。
- 隔离后端 `4568` 已停止、`.cache/iso-home` 已删除；如需再做真实模型/写操作验收，按 `docs/testing-isolation.md` 重新拉起即可。

## 第 16 轮（2026-10-13 续）：侧栏项目操作 / 输入栏上下文清除 / 定时会话过滤

对照 `components/Sidebar.vue`、`components/ChatInput.vue`、`components/SchedulePanel.vue` 补了 3 处仍差于旧 web 控制台的交互；均为纯前端、复用已有后端端点。

### 1. 侧栏项目操作（旧 `Sidebar.vue`）

- **每个项目的「+新建会话」**：旧项目行有独立 `project-new` 按钮。`web/src/App.tsx` 的 `.workspace-tools` 在「刷新 / 管理」前补 `IconButton label="在 {name} 新建会话"` → `newSession(item.hash)`。（旧版点项目名是折叠/展开、`+` 才新建；新版点项目名就已新建，这里补 `+` 使按钮可见、与旧一致。）
- **「定位当前会话」**：旧 `.sidebar-section-actions` 有定位按钮，滚动当前会话进入视口。新增 `sessionSection` ref，`.session-section` 挂 ref，会话行加 `data-session-key={entry.id}`，`.section-label` 工具栏补 `Crosshair` 图标按钮调用 `locateActiveSession()`（遍历 `[data-session-key]` 匹配 `activeId` 后 `scrollIntoView({block:'center'})`）。
- **项目拖拽排序**：旧 `project-item` 可拖拽。给 `.workspace-group` 加 `draggable` + `onDragStart/onDragOver/onDragLeave/onDrop/onDragEnd` 与 `dragging` / `drag-over` 态；`reorderWorkspaces(from,to)` 重排后 `PUT /workspaces/order` 再 `backend.refresh()`（与设置 → 项目里的 ↑/↓ 共用端点）。样式 `.workspace-group.dragging/.drag-over` 加在 `web/src/styles.css`。浏览器可拖动排序未在 IAB 里模拟（无拖拽事件），端点/载荷与排序逻辑由 `workspace-manage.test.mjs`（同一 PUT）与代码路径覆盖。

### 2. 输入栏上下文「清除」（旧 `ChatInput.vue` `clearSelectedFileContexts` 等）

- 旧版对文件上下文 / 上传 / 大段粘贴 / 技能 / 关联项目各有一个「清除」按钮；新版把 projects/skills/files 合并成一行 chip，只有逐条 `×`，缺「全部清除」。
- `web/src/components/Composer.tsx` 的 `.composer-context-chips` 在 chip 之后、有任一上下文时渲染「清除」按钮 → `onContext({ ...context, projects: [], skills: [], files: [], attachments: [] })`。样式 `.context-clear-all` 加在 `web/src/composer.css`。
- 浏览器实测：关联项目选 1 项 → chip `defaultWorkSpace` 出现且右侧出现「清除」；点「清除」后 chip 与按钮同时消失。

### 3. 定时任务「只显示当前会话」过滤（旧 `SchedulePanel.vue` `filterSession`）

- `web/src/components/SchedulePanel.tsx`：新增 `onlySession` 状态与 `tasks` 过滤（`onlySession && sessionName` 时只留 `task.sessionName === sessionName`）；「新建定时任务」旁补「只显示当前会话」复选框；空态区分「当前会话暂无定时任务」与「暂无定时任务」。
- 浏览器实测：会话 → 工作区面板 → 定时，出现「新建定时任务」+「只显示当前会话」，空态文案正确。

### 4. 本轮验证

- 类型检查：`tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **228 全过**。
- 生产构建：`vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 真实后端 `4567`）：侧栏出现「定位当前会话」（1 个）、每个项目「在 {name} 新建会话」（3 个含顶部「新建会话」）、`.workspace-group[draggable=true]` 计数与项目数一致；输入栏清除按钮行为正确；定时面板过滤复选框渲染正确；全程 **0** console error / warning。

### 5. 仍未迁移 / 待办（第 16 轮）

- 项目拖拽排序只在浏览器里静态确认了 `draggable` 属性与拖拽态样式；真实拖放事件未在 IAB 模拟（IAB 无 drag API），排序结果由「设置 → 项目」↑/↓ 与 `workspace-manage.test.mjs` 覆盖同一端点。
- 旧输入栏的独立分组（文件 / 上传 / 大段粘贴 / 技能 / 项目各自一行 + 各自「清除」）在新版仍合并为单行 chip + 单一「清除」，属交互简化。
- 其余同第 15 轮：Electron 桌面能力、Monaco 编辑、`SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 旧视觉、`entry-routing.js` 桌面窗口指向 Vue（设计取舍）；长粘贴真实 `ClipboardEvent` 无法在浏览器模拟。

## 第 17 轮（2026-10-13 续）：文件面板「折叠全部」+ 测试修复 + 迁移完成度复核

### 1. 文件面板「折叠全部」（旧 `FileExplorer.vue`）

- 旧文件树工具条有「折叠全部」按钮，一键清空所有展开目录。`web/src/components/FilesPanel.tsx` 的 `.file-search` 栏在 `expanded.size > 0` 时渲染 `.collapse-tree` 按钮（lucide `ChevronsDownUp`），点击 `setExpanded(new Set())` 折叠整棵树；无展开目录时按钮不出现。
- 样式 `.collapse-tree` 追加在 `web/src/workbench.css`（与已有 `.clear-search` 同风格）。
- 浏览器实测（dev `3000` → 后端 `4567`）：工作区面板 → 文件 → 初始无按钮（`count=0`）；展开 `src` 后出现按钮（`count=1`）且条目由 19 增至 20；点击折叠后按钮消失（`count=0`）、条目回到 19（子节点隐藏、顶层仍在）。全程 `0` console error / warning。

### 2. 修复 `files-panel.test.mjs`（上轮遗留失败）

- 上轮 `FilesPanel.tsx` 新增 `ChevronsDownUp` 图标后，`web/tests/files-panel.test.mjs` 的 lucide data-URL stub 未导出该符号，导致 `does not provide an export named 'ChevronsDownUp'` 失败。
- 修复：在 stub 的导出列表补 `ChevronsDownUp=()=>null`；并新增用例「collapse all clears every expanded directory」——断言未展开无按钮、展开后出现、点击后子节点隐藏且按钮消失。

### 3. 迁移完成度复核（逐端点 / 逐设置项 / 逐可见文案对比）

- **REST 端点**：抽取 legacy `src/**`（排除 Electron 专属文件）与 `web/src/**` 的接口字符串对比。legacy 中只在 `services/api.js` 定义、**任何 UI 组件都不调用**的包装（`/api/jobs*`、`/api/memory*`、`/api/agent/info`、`/api/agent/stats`、`/api/usage/history`、`/api/usage/reset`、`/api/sessions/import`）不是 UI 功能，不计入缺口；`/api/agent/retry`、`/api/agent/rewind`、`/api/agent/compact` 仅出现在 `views/Help.vue` 的接口文档表里，前端未调用。其余端点（sessions/workspaces/files/git/tools/skills/plugins/mcp/lsp/openapi/snapshots/requirements/schedules/pets/usage/sub-agents/sub-sessions…）在新前端均有对应调用。
- **设置项**：`settingsCategories`（通用 / 模型服务 / 智能体[会话默认·系统提示词·子代理] / 工具与集成[工具·技能·插件·拓展包·MCP·LSP·OpenAPI·浏览器] / 工作区与数据[项目·已隐藏会话·用量] / 连接与帮助[服务·快捷键·关于]）覆盖旧 `Settings.vue` 全部标签（general/tools/sub-agents/dashboard/pet/server/model-channels/workspace/plugins/extpacks/prompt/openapi/mcp/lsp/skill-market/about/ai）。
- **可见文案**：抽取 legacy 模板里的 `title=`/`placeholder=` 中文串与 web 源对比。剩余「未命中」项均为**措辞差异**而非缺功能，已逐条核对：模型价格配置（`ModelProviderSettings.tsx` 每个模型「配置价格」+ 输入/缓存/输出 元/百万 tokens）、常用要求增删改（`/prompt-presets`）、需求池优先级（`requirementPriorityLabel` + `REQUIREMENT_PRIORITY_OPTIONS`）、子代理角色字段、git 作者配置与「AI 生成说明」、拓展包按 JAR 地址/路径安装、`继续生成`、排队「引导（停止当前生成…）」等都已存在。
- **结论**：web 控制台相对 `legacy.html` 的**功能**已对齐；剩余差异为两类——(a) Electron/桌面专属能力（设计取舍，见下），(b) 措辞/交互简化（如「添加预设」→「添加要求」、单行 chip 取代分组「清除」）。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **229 全过**（较上轮 228 新增「折叠全部」用例）。
- 生产构建：`vite build` 通过（仅既有 chunk 体积警告；`monaco` 等大块属旧 Vue 控制台产物）。
- 浏览器验收：文件面板「折叠全部」出现/生效见 §1；全程 `0` console error / warning。

### 5. 仍未迁移 / 待办（第 17 轮，沿用）

- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`、`ElementPanel.vue`、窗口控制类 `TitleBar.vue`）、Monaco 文件编辑（后端无写文件接口）、`SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 旧视觉：设计取舍，未迁移。
- 长粘贴真实 `ClipboardEvent` 仍无法在 IAB 模拟（只有后端契约 + 前端代码/单测保证）。
- 交互简化：输入栏合并为单行 chip + 单一「清除」；文件树/搜索等刷新使用工作区面板的统一「刷新」按钮（旧版为各页签独立刷新标题）。
- 上述「可见文案」剩余差异为措辞级，如需与旧版逐字一致可再对齐，但不影响功能。

## 第 18 轮（2026-10-13 续）：删除并行 mock 设置页 + 设置全页浏览器复核

### 1. 删除与后端实现并行的「本地 mock」设置页（消除「还有 mock 页=未迁移」的歧义）

- 复核发现 `web/src/components/AgentSettingsPages.tsx` 里有 7 个**从未被引用**的本地 mock 页：`ProjectSettings`、`ServerSettings`（文案「本地 mock · 未连接后端」）、`ToolSettings`、`SkillSettings`（「管理本地演示技能」）、`SubAgentSettings`、`DashboardSettings`（「实际费用：未接入」）、`ExtensionSettings`（「添加演示条目，不下载或执行」）；文件里只有 `AgentDefaults`、`PromptSettings` 是实际使用的（`Settings.tsx` 仅导入这两个）。
- `web/src/components/IntegrationSettings.tsx` 整个模块也**从未被引用**（MCP/LSP/OpenAPI 实际走 `IntegrationManager`，保存到后端）。
- 处理：删除 `IntegrationSettings.tsx`；把 `AgentSettingsPages.tsx` 精简为只保留 `SettingsPageProps` / `AgentDefaults` / `PromptSettings`（同步修剪 import，满足 `noUnusedLocals`，并加注释说明其余设置页已迁到后端驱动页）。
- 依据：与第 13 轮 §9「删除误导性死代码」同一原则——仓库里保留一份并行的 mock 实现会让「对照 legacy 是否还缺功能」的结论失真。删除后设置页每页只有一份权威（后端驱动）实现：项目=`BackendProjects`、服务器=`BackendServer`、工具/技能/插件/拓展包/子代理=`ResourceManagers`、用量=`UsageDashboard`、MCP/LSP/OpenAPI=`IntegrationManager`。

### 2. 本轮验证

- 类型检查：`tsc -b web/tsconfig.json` 通过（删除后无残留引用）。
- 单测：`node --test web/tests/*.test.mjs` **229 全过**（`usageSummary` 仍被 `settings.test.mjs` 使用，故保留）。
- 生产构建：`vite build` 通过。
- 浏览器全设置复核（dev `3000` → 后端 `4567`，IAB）：通用 / 模型供应商 / 会话默认 / 系统提示词 / 子代理 / 项目 / 已隐藏会话 / 用量 / 服务器 / 快捷键 / 关于 全部渲染且无 `[role=alert]` 报错；工具与集成下拉逐项打开 技能（已安装）/ 插件（运行时插件 · loopra-prompt）/ 拓展包 / MCP 服务器（发布 Loopra 工具）/ 语言服务（LSP 服务器）/ OpenAPI 接口源 / 浏览器 全部渲染；全程 **0** console error / warning。

### 3. 仍未迁移 / 待办（第 18 轮，沿用）

- 同第 17 轮：Electron 桌面能力、Monaco 编辑、旧 `SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 视觉（设计取舍）；长粘贴真实 `ClipboardEvent` 无法在浏览器模拟；残留为措辞级/交互简化差异。
- 本轮已消除最后一批「本地 mock」设置页，web 控制台不再存在「演示/未接入」占位实现。

## 第 19 轮（2026-10-13 续）：输入栏逐行对比 `ChatInput.vue` → 补图片缩略图 / 附件大小 / 大段粘贴字符数

### 1. 逐行对比结论（`src/components/ChatInput.vue` vs `web/src/components/Composer.tsx`）

- 旧输入栏把上下文分成多组 chip：已引用文件（`selectedFileContexts`）、元素检查（`selectedElementContexts`，桌面 ElementInspector 专属）、已选技能、关联项目、上传文件、大段粘贴、图片（`.image-preview-bar` 缩略图），外加 `session-actions` / `plan-review` 两个插槽。
- 新组件已覆盖：技能、关联项目、文件路径（`@` 引用 / 大段粘贴路径）、上传文件解析（`documents.ts` 的 PDF/Word/Excel/文本管线）、大段粘贴落盘（`POST /files/paste`）、计划模式、权限、模型/推理、排队消息、`/` 指令与 `@` 联想、Goal/清单（`SessionDetails.tsx`）；`App.tsx::sendMessage` 会把 `context.attachments` 的 `text`/`image` 真正并入请求（上传文档内容与图片都发送，不是只发文件名）。
- `session-actions` 插槽只被 `views/Sessions.vue` 使用，而 `App.vue`（legacy web 控制台根组件）既不渲染 `<router-view>` 也不 `router.push`，`/sessions` 等路由在 web 控制台里不可达——**不是缺口**（`App.vue` 里 `useRouter()` 的返回值也是未使用的死变量）。
- 真正仍差于旧版的可见点：图片粘贴/上传只有文字 chip、没有缩略图；上传文件 chip 不显示大小；大段粘贴 chip 不显示字符数。本轮补齐。

### 2. 图片缩略图 + 附件大小 + 大段粘贴字符数（`ChatInput.vue` 的 `.image-preview-bar` / `.upload-chip-size` / `{{ chars }} 字符`）

- `web/src/composer.ts`：新增 `ComposerAttachment` 类型（含 `size?`）与纯函数 `attachmentViews(context, pasteChars)`——把上下文拆成 `images`（缩略图，带 data URL）与 `files`（文件 chip，带 `size` 或粘贴 `chars`），并把图片从文件列表里剔除以免重复。
- `web/src/components/Composer.tsx`：
  - `addFiles` 给每个附件记录 `size: file.size`；`handlePaste` 保存大段粘贴后把 `chars` 记进 `pasteChars` 状态（键为落盘路径）。
  - `.composer-context-chips` 改为：先渲染 `.composer-image-thumb`（`img.composer-image-preview` + `.composer-image-remove` 移除按钮），再渲染项目/技能 chip，再渲染文件 chip（文件 chip 追加 `.context-chip-size`，显示 `N 字符`（粘贴）或格式化字节数（上传）），最后是「清除」。
  - 移除按钮统一走 `removeAttachment(name)`，同时清 `context.files` 与 `context.attachments`。
- 样式 `web/src/composer.css`：新增 `.composer-image-thumb` / `.composer-image-preview` / `.composer-image-remove` / `.context-chip-size`（对齐旧 `.image-preview-bar` 的 56px 方图 + 右上角移除按钮）。

### 3. Git 面板：初始化可选「创建首次提交」+ Git 页签改用并排 DiffViewer（对照 `GitPanel.vue`）

- 旧 `GitPanel.vue` 在未初始化态提供「初始化后创建首次提交」复选框，并调用 `POST /git/init?workspaceHash=..&initialCommit=true|false`（后端 `GitController#initRepo(workspaceHash, initialCommit)` 支持该参数）。`web/src/components/GitTools.tsx` 补 `initCommit` 状态（默认 true）+ 复选框，初始化请求改为 `query({ workspaceHash, initialCommit: initCommit })`，确认弹窗文案同步「并创建首次提交」。
- 旧 `GitPanel.vue` 的文件 diff 走 `DiffViewer.vue`（并排 + 差异块导航 + diff/内容模式）；新前端 Git 页签此前只是 `<pre>{diff.data?.diff}</pre>` 纯文本。`web/src/components/Panels.tsx` 改为引用 `DiffView`（与文件面板共用、单测已覆盖的并排组件）：`<RemoteState {...diff} />{diff.data && <DiffView diff={diff.data.diff} />}`。内容模式仍由文件面板（`FilesPanel` 的文件预览）提供。
- 旧 Git 面板的提交模型选择是 `/models` 下拉（含渠道分组/搜索/校验）；新前端原为自由文本输入，本轮见 §3b 已改为按渠道分组的下拉。

### 3b. Git 面板：提交模型改为按渠道分组的下拉（对照 `GitPanel.vue` 的 `/models` 下拉）

- 新增纯模块 `web/src/git-models.ts`：`groupGitModels`（按 `channelId` 分组、`channelName` 作组名、保持服务端顺序、丢弃空名）、`gitModelValue` / `gitModelFromValue`（`channelId::name` 选项值往返）、`gitModelKnown`（校验已保存模型是否仍可选，空模型视为「继承」= 已知）。
- `web/src/components/GitTools.tsx`：新增 `useRemote('/models')`，把「提交作者与生成模型」里的 `生成模型 / 模型渠道 ID` 两个自由文本框换成 `<select aria-label="生成模型">`（`<optgroup>` = 渠道名，首选项「留空继承默认模型」），并在模型不在可用列表时渲染 `role="status"` 警告（对齐旧 `modelWarning`）。作者名称/邮箱仍为输入框，保存仍走 `POST /git/config`。


### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **235 全过**（较上轮 229 新增 6 项：`composer.test.mjs` 的 `attachmentViews` 拆分用例 + Composer 渲染标记断言；新增 `git-panel.test.mjs` 的「初始化可创建首次提交」「Git 页签用 DiffView 而非裸 `<pre>`」「提交模型按渠道分组往返」「Git 面板渲染分组下拉」）。另修正 `terminal-panel.test.mjs` 的 import stub（Panels.tsx 新增 `./DiffView` 依赖需注入 stub）。
- 生产构建：`vite build` 通过（仅既有 chunk 体积警告；`dist/renderer/assets/css/main-*.css` 与 `main-*.js` 已含 `composer-image-thumb`）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB）：
  - 输入栏：`@src` 联想 → 选中 `src/App.tsx` 后 `.composer-context-chips .chip-files` 出现 1 个（文本 `src/App.tsx`、无 size span，与普通引用一致）；点「清除」后 chip 与按钮同时消失。
  - Git 页签：打开改动面板 → Git（`master · 1 个改动`、1 个 `.git-file-row`）→ 点文件名后工作区预览渲染 `DiffView` 的空态文案「该文件没有未提交的改动。」（此前是裸 `<pre>` 的「没有文本差异」），确认并排 DiffView 已接入。
  - Git 提交模型：展开「提交作者与生成模型」，出现唯一 `select[aria-label="生成模型"]`，`<optgroup label="Kimi Code · DeepSeek">`（渠道名正确），首选项「留空继承默认模型」，选中可用模型后无警告；未点「保存提交配置」（不写 config）。
  - 全程 `0` `[role=alert]`。
- **受限项**：IAB 的 `locator.evaluate` / `playwright.evaluate` 沙箱里 `File`/`Blob`/`DataTransfer`/`Event`/`document.createElement` 全部不可用，且 Playwright 封装未暴露 `setInputFiles`，无法在浏览器里真实上传图片去点检缩略图——图片缩略图/字节数分支由 `attachmentViews` 单测 + `Composer.tsx` 渲染标记断言 + 构建产物覆盖（与长粘贴同一类限制）。

### 4. 仍未迁移 / 待办（第 19 轮）

- 同第 17/18 轮：Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`、`ElementPanel.vue`、窗口控制类 `TitleBar.vue`）、Monaco 文件编辑（后端无写文件接口）、旧 `SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 视觉：设计取舍。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue。
- 旧版对**直接键入**的超大正文（>32KB）在发送前会落盘外置；新版只对 `paste` 事件做外置（阈值 8000 字符）。属边界差异，未实现（避免改动发送链路引入回归）。
- 交互简化：输入栏仍为单行 chip + 单一「清除」；图片/上传/粘贴不再各自分组。
- Git 面板「初始化后创建首次提交」复选框与「Git 页签并排 diff」为**代码 + 单测**保证：当前后端 `4567` 挂载的两个工作区都不是「未初始化」态（`defaultWorkSpace` 未初始化但 UI 切过去需要新建会话，`loopra-web-ui` 已初始化且仅 1 个无文本 diff 的未跟踪项），因此未在浏览器里点出「有真实文本差异」的并排效果（已确认渲染的是 `DiffView` 组件）。

## 第 20 轮（2026-10-13 续）：消息级操作逐行对比 `ChatMessage.vue` → 补文件统计 / 工具卡参数 / 原始记录入口

本轮先纠正上一轮交接里一处**误判**，再逐行对比 `ChatMessage.vue` / `BlockRenderer.vue` 补三个真实缺口。

### 0. 纠正：`stream_reset` 并非缺口

- 上一轮交接笔记称「新前端搜不到 `stream_reset`」——不成立。`web/src/backend.ts:136` 的 `applyEvent` 已处理 `stream_reset`（弹掉尾部的 `content`/`reasoning`/`reasoning_started`，保留已完成的工具），SSE 层还有 `terminalReply=false` 的收尾处理（`backend.ts:66`），并有单测（`web/tests/backend.test.mjs` 三处）。旧的 `streamResetIndex` 写法与新写法在「重试丢弃本轮正文/思考」上等价，无需改动。

### 1. 助手消息文件统计：拆「修改 / 新增」（对照 `ChatMessage.vue` 的 `fileStats`）

- 旧版按工具拆分：`edit`→修改、`write`→新增，按 `file_path` 去重，`finish` 不计；拆成「修改 N 文件」「新增 N 文件」两个可点击项。
- 新版此前把 `file_changes` 的所有条目一律显示为「修改 N 文件」（`created` 的文件也被算作修改），属真实偏差。
- 新增纯模块 `web/src/file-stats.ts`：`messageFileStats(blocks)`——先按流式 `file_changes` 的 `created` 标志分桶，再用 `tool_call` 的 `edit`/`write` + `args.file_path` 兜底（对齐旧版），返回 `{ edited, created }`。
- `web/src/components/Conversation.tsx` 的 `AssistantMessage` 改用 `messageFileStats(blocks)`，分别渲染「修改 N 文件」「新增 N 文件」（`title` 列出全部路径，点击打开首个文件的 diff）。

### 2. 工具卡内联参数与可点击文件名（对照 `BlockRenderer.vue`）

- 旧版按工具名格式化内联参数：`bash` 命令截断到 60 字（57 + `...`）、`grep`/`glob` 路径截断到 50 字、`ls` 显示全路径、`ask_choice` 显示问题（超 40 字截断）+` (N 项)`；`read`/`edit`/`write` 的 `file_path` 渲染成**可点击文件名**，点击打开该文件（`shouldShowOpenFile`）。
- 新版此前只有 `command || file_path || pattern || path` 的裸文本（不可点击、不截断、`ask_choice` 无参数）。
- 新增纯模块 `web/src/tool-params.ts`：`toolParam(name, args)` 返回 `{ text, title?, filePath? }`，规则与旧版一致，未知工具回退到原通用取参。
- `web/src/components/BlockRenderer.tsx` 的 `ToolBlock` 用 `toolParam` 渲染：有 `filePath` 时渲染 `.tool-file`（因头部是 `<button>`，用 `role="button"` 的 `<span>` 避免非法嵌套；`stopPropagation` 不触发折叠），`onOpenFile` 透传 `actions.onDiff`（工具组内的 `ToolBlock` 也接上）。样式 `.tool-file` 追加在 `web/src/chat-blocks.css`。

### 3. 压缩摘要「查看原始记录」（对照 `ChatMessage.vue` 的 `viewRawEvents`）

- 旧版「较早对话已压缩」卡片有「查看摘要」+「查看原始记录」两个按钮，后者打开会话原始事件浮层。
- 新版此前只有「查看摘要」，原始记录只能从会话菜单进入。
- `web/src/components/Conversation.tsx`：`MessageActions` 新增可选 `onRawEvents`，压缩摘要卡片在其存在时渲染 `.compacted-raw-btn`「查看原始记录」。
- `web/src/components/SessionDetails.tsx`：新增 `initialTab`（默认 `'events'`），`useState(initialTab)` 播种。
- `web/src/App.tsx`：新增 `sessionDetailsTab` 状态；`Messages` 传入 `onRawEvents={() => { setSessionDetailsTab('events'); setSessionDetails(true); }}`；`SessionDetails` 传入 `initialTab={sessionDetailsTab}`。样式 `.compacted-body`/`.compacted-raw-btn` 追加在 `web/src/chat-blocks.css`。

### 4. 复核为非缺口 / 不可迁的点（勿重复劳动）

- **环境面板变更清单 / 提交记录**：旧 `EnvironmentPanel.vue` 的「当前/本地变更清单」「提交记录」浮层依赖 `window.electronAPI.gitEnvironment` 桥（`desktopGit()`，无桥即提示「请重启桌面端」）；后端 `/git/environment` 只返回 `mode/mainPath/mainDirty/currentPath/currentDirty/worktreeExists/agentRunning/message`，**不含文件清单与分支历史**，`/git/log` 在 `GitTools.tsx` 已用于 Git 页签提交记录。故属桌面桥专属，不算 Web 缺口。
- **`EnvironmentPanel.vue` 的 `mergeCurrent()`**：旧文件里定义了但**模板从未绑定**（死代码），未迁移。
- **侧栏「折叠所有项目」「定位当前会话」**：`App.tsx` 已有「折叠工作区」全局开关（`setCollapsed`）与 `locateActiveSession`。
- **全局快捷键**：旧侧栏提示 `Ctrl+Alt+N`/`Ctrl+K`，实现是 `altKey+n`/`ctrl+k`；新版绑定 `Ctrl+N`（新建）、`Ctrl+K`（搜索）、`Ctrl+,`（设置）、`Esc`，覆盖同一意图。

### 5. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **246 全过**（较上轮 235 新增 11 项：新增 `file-stats.test.mjs` 4、`tool-params.test.mjs` 5、`session-details.test.mjs` 1，`chat-scroll.test.mjs` 补「压缩摘要→原始记录」1；并给 `chat-scroll.test.mjs` 的 `Conversation.tsx` 依赖表补 `../file-stats` stub）。
- 生产构建：`$env:TEMP=...; node node_modules/vite/bin/vite.js build` 通过（`dist/renderer/assets/css/main-*.css` 已含 `.tool-file`/`.msg-file-stat`/`.compacted-raw-btn`）。
- 浏览器验收（dev `3000` → 真实后端 `4567`，IAB tab 20）：
  - 打开 `loopra-web-ui` 的「好无聊啊」会话，展开思考过程后 `.tool-file` 渲染 `backend.ts`（read 工具），bash 工具参数显示为截断的 `cd /d C:\\...`；**点击该文件名打开工作区面板并预览 `src/backend.ts`**（端到端可用）。
  - 会话选项 →「原始记录与快照」打开 `[aria-label="会话记录"]`，默认选中「原始记录」页签、渲染 68 512 字符原始事件；关闭正常。
  - 全程 **0** `[role=alert]`、**0** console error/warning。
  - 受限：当前挂载的会话没有「较早对话已压缩」消息，压缩摘要上的「查看原始记录」按钮由 `chat-scroll.test.mjs`（挂载 `Messages` 点击断言）覆盖；`修改/新增` 计数需带 `file_changes` 的回合，由 `file-stats.test.mjs` 覆盖。

### 6. 仍未迁移 / 待办（第 20 轮，沿用）

- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`、`ElementPanel.vue`、窗口控制类 `TitleBar.vue`）、Monaco 文件编辑（后端无写文件接口）、旧 `SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 视觉：设计取舍。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue。
- 直接键入的 >32KB 正文不在发送前落盘外置（旧版行为）；交互简化同前（单行 chip + 单一「清除」等）。

## 第 21 轮（2026-10-13 续）：修 1 处测试失败 → 系统提示词 Markdown/复制 + 消息文件改动复用存储 diff

本轮先修掉第 20 轮遗留的失败测试，再补两个真实缺口，并做浏览器端到端验收。

### 1. 修掉 `session-progress.test.mjs` 的模块解析失败

- 现象：`node --test web/tests/session-progress.test.mjs` 的「status maps match the legacy GoalSteps / ChecklistSteps tables」用例抛 `ERR_UNSUPPORTED_RESOLVE_REQUEST: Failed to resolve module specifier "./Markdown"`。
- 根因：`SessionDetails.tsx` 本轮新增 `import Markdown, { copyText } from './Markdown'`，而该测试用 data-url 转译组件并把依赖换成注入的 stub；文件里**两处** `sourceUrl('components/SessionDetails.tsx', {...})`（模块级挂载 + 状态映射用例）的依赖表都缺 `./Markdown`。第一处补上后仍报错，是因为第二处独立 import 调用未补。
- 修法（`web/tests/session-progress.test.mjs`）：新增 `markdownStub`（默认导出组件 + `copyText`），并**在两处** `sourceUrl` 依赖表都加 `'./Markdown': markdownStub`。未改产品代码迁就测试。

### 2. 实际系统提示词：Markdown 渲染 + 复制按钮（对照 `Chat.vue` 的 `viewSystemPrompt` / `promptModalOpen`）

- 旧版用 `fmtPrompt`（Markdown）渲染系统提示词并提供「复制」按钮；新版此前只是 `<pre>` 纯文本 dump。
- `web/src/components/SessionDetails.tsx`：新增 `notify?` 参数；import `Markdown, { copyText }`；「实际系统提示词」页签改为「复制提示词」按钮（`copyText(promptText(prompt.data), notify)`）+ `<div className="session-prompt-md"><Markdown text={promptText(prompt.data)} notify={notify} /></div>`。
- `web/src/App.tsx`：`SessionDetails` 传入 `notify={notify}`，让复制操作能弹提示。
- `web/src/workbench.css`：新增 `.session-prompt-actions` / `.session-prompt-md`。

### 3. 消息文件改动：复用历史存储的 diff（对照 `Chat.vue` 的 `openStoredDiff(change)`）

- 旧版点消息里的文件改动直接用 `change.diff`（历史里存好的 diff），不走 `/git/diff`；新版此前一律 `onDiff(path)` 再拉远端 diff，历史里已有的 `diff` 被丢弃。
- `web/src/components/BlockRenderer.tsx`：`BlockActions.onDiff` 签名改为 `(path: string, diff?: string)`；`FileChanges` 的主按钮与 `.file-change-row` 都传 `change.diff`。
- `web/src/components/Panels.tsx`：`WorkspaceProps` 新增 `initialDiff`；改动面板渲染时若 `file === initialFile && initialDiff !== undefined` 直接用 `<DiffView diff={initialDiff} />`，否则回退到 `<RemoteState /><DiffView />` 拉远端。
- `web/src/App.tsx`：新增 `diffInline` 状态；`openDiff(path, storedDiff?)` 记录 `diffInline`；`ChangesPanel` 传 `initialDiff={diffInline}`。

### 4. 本轮验证

- 类型检查：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json` 通过。
- 单测：`node --test web/tests/*.test.mjs` **248 全过**（较上轮 246 +2，均来自 `session-progress.test.mjs` 修好后的 6 用例）。
- 生产构建：`$env:TEMP=...; node node_modules/vite/bin/vite.js build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 真实后端 `4567`，IAB tab 21）：
  - 会话选项 →「原始记录与快照」→「实际系统提示词」：`.session-prompt-md` 渲染出 27 个 Markdown 块元素（p/ul/pre 等，非 `<pre>` 纯文本），存在唯一「复制提示词」按钮；点击后无报错。
  - 存储 diff：临时向 `227471021ab1` 写入一个带 `file_changes.diff` 的会话（`loopra-20990101999999`），刷新后打开——消息出现 `app.ts +1 −0 文件已修改` 改动卡，点击后工作区 Git 页签渲染 `src/app.ts` 的并排 diff，含合成的 `+const y = 2;` 行（`const y = 2;` 命中 1 次）。**因该工作区未初始化 Git，远端路径必失败，能看到该 diff 即证明走的是存储分支。** 验收后已删除该临时会话文件（再次 `/api/sessions` 已不再返回它）。
  - 全程 **0** console error、**0** `[role=alert]`。

### 5. 仍未迁移 / 待办（第 21 轮，沿用）

- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`、`ElementPanel.vue`、窗口控制类 `TitleBar.vue`）、Monaco 文件编辑（后端无写文件接口）、旧 `SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 视觉：设计取舍。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue。
- 直接键入的 >32KB 正文不在发送前落盘外置（旧版行为）；交互简化同前（单行 chip + 单一「清除」等）。
- 侧栏「会话批量清理 / 工作区排序与移除」入口、公式渲染的端到端（真实发含 `$x$` 消息）验收：见设置页 `DELETE /sessions`、`/sessions/cleanup` 与 `markdown-math` 单测。

### 6. 追加：文件树 Git 状态装饰（对照 `FileExplorer.vue` / `FileExplorerNode.vue`）

- 旧版文件树给每个改动文件标 M/A/D/U 字母（`decorationFor`）、并给其**祖先目录**染一个同色小圆点（`loadGitDecorations` 用 `GET /git/status` 的 `changed`/`untracked` 构建「路径→装饰」表，未初始化则整表清空）。新版 `FilesPanel.tsx` 完全没接 git 状态，属真实缺口。
- 新增纯模块 `web/src/git-decorations.ts`：`decorationFor(status)`（U/?→untracked、A→added、D→deleted、其余→modified，与旧版一字不差）、`relativeGitPath(path)`（反斜杠 → 正斜杠、去前导斜杠）、`buildDecorations(status)`（按**工作区相对路径**建表：文件给字母，祖先目录给空 label + 同一 kind）。
- `web/src/components/FilesPanel.tsx`：新增 `useRemote<GitStatus>('/git/status?...', revision)`，`buildDecorations(status.data)` 得到装饰表；目录行渲染 `.fen-decoration.is-<kind>.is-directory`（圆点），文件行渲染带字母的 `.fen-decoration.is-<kind>`，命中的 `.workspace-tree-entry` 追加 `decorated is-<kind>` 给名字染色。
- `web/src/workbench.css`：新增 `.workspace-tree-entry.decorated…` / `.fen-decoration.is-*` 规则，配色沿用旧版（modified `#a67622`、untracked/added `#168124`、deleted `#c43b3b`，目录圆点 6px + `currentColor`）。

### 7. 追加验证（文件树装饰）

- 单测：新增 `web/tests/git-decorations.test.mjs`（5 项：状态映射 / 路径归一 / 未初始化清空 / 祖先传播 / 空路径跳过）；`web/tests/files-panel.test.mjs` 给 `FilesPanel` 依赖表补 `'../git-decorations'` stub 并新增 2 项（初始化后渲染 M 字母 + 目录圆点、未初始化不渲染）。**全量 255 全过**。
- 浏览器验收（dev `3000` → 真实后端 `4567`，IAB tab 21）：当前挂牌的两个工作区的 Git 根都不是工作区路径本身（`loopra-web-ui` 是其 Git 根 `loopra_code` 的子目录，`/git/status` 返回的前缀路径 `loopra-web-ui/...` 与文件树的工作区相对路径对不上），无法直接点出装饰。故用受支持的 `POST /api/workspace {path}` 临时登记一个自身即 Git 根的临时仓库 `_deco_test_1`（`git init` + 一次提交 + 改 `src/a.txt`、加 `src/new.ts`）：文件树出现 `src` 目录琥珀圆点、`a.txt ` 后跟琥珀 `M`、`new.ts` 后跟绿色 `U`，`decorated is-modified` / `is-untracked` class 与配色正确；**0** console error、**0** `[role=alert]`。验收后 `POST /api/workspace` 切回原目录、`DELETE /api/workspaces/fdf8191264a6` 注销、并删除临时目录（`/api/workspaces` 已恢复为 2 个）。
- 说明：Git 根 ≠ 工作区路径时装饰（以及 Git 页签的 diff）会对不上，这是**环境/后端路径语义**问题而非本轮引入；旧版 `FileExplorer` 用 `rootPath + relative` 拼路径，同样假设工作区即 Git 根，故不算回归。

## 第 22 轮（2026-10-13 续）：子代理工具一键导入 + Git 历史相对时间/环境重载 + 文件类型图标

### 1. 子代理「工具白名单」一键导入只读/写入（对照 `SubAgents.vue` 的 `importReadOnlyTools` / `importWriteTools`）

- 旧版头部有两个按钮，把当前白名单整体替换为全部可用只读 / 写入工具（排除子代理不可用 `SUB_AGENT_DENY` 与已禁用工具）。
- `web/src/components/ResourceManagers.tsx`（`SubAgentManager`）：`/tools` 类型补 `enabled?`；在「工具权限」展开区（仅 `allowedTools !== null`，即非「继承可用工具」时）新增「一键导入只读」「一键导入写入」两个 `type="button"` 按钮，点击把 `allowedTools` 设为 `tools.data` 中「排除 `denied`、`enabled === false`，按 `readOnly` 分组」的名字数组。

### 2. Git 面板：提交历史相对时间 + 从现有环境获取（对照 `GitPanel.vue` 的 `fmtRelative` / `handleFetchGitConfig`）

- `web/src/components/GitTools.tsx`：新增模块级 `fmtRelative(date)`（刚刚 / N 分钟前 / N 小时前 / N 天前 / 兜底原串），提交历史项渲染 `<small title={commit.date}>{author} · {fmtRelative(date)}</small>`（此前直接显示 `commit.date`）。
- 「提交作者与生成模型」区新增「从现有环境获取」按钮：`reloadConfig()` 重新拉 `GET /git/config` 并合并进 author 字段；保存仍走原「保存提交配置」。
- **未迁移（有意）**：旧版还有「恢复默认」把作者重置为应用默认 `Loopra` / 默认邮箱。该默认邮箱在后端是常量 `DEFAULT_AUTHOR_EMAIL`，在当前渲染环境里被脱敏，前端无法硬编码；忠实实现需后端新增一个返回默认值的只读端点。为不引入未部署的后端路由、不侵入用户正在运行的 Java 进程，本轮**不改后端**，仅把该按钮列入待办。

### 3. 文件树按文件类型图标（对照 `utils/fileIcons.js` / `FileExplorerNode.vue`）

- 新增纯模块 `web/src/file-icons.ts`（1:1 端口）：`FILE_ICONS` / `EXTENSION_ICONS` / `iconKind` / `fileIconFor`，保留旧版 kind、color 与 codicon 名；优先级依次为 `package(-lock).json`/`pnpm-lock`/`npm-shrinkwrap`、`pom.xml`、`build|settings.gradle(.kts)`、`Dockerfile`/`docker-compose.*`、`.git*`、`.env*`，再按扩展名，最后 `default`。
- `web/src/components/FilesPanel.tsx`：`FILE_GLYPHS` 把 kind 映射到 lucide 图标（java→Coffee、json→FileJson、yaml→ListTree、shell/powershell→Terminal、database→Database、image→FileImage、archive→FileArchive、config/rust→Settings、git→GitBranch、npm/maven/gradle→Package、docker→Container、css/sass/svg→Palette、其余→FileCode）；`<FileGlyph>` 输出 `data-icon={kind}` + `style={{ color }}`，文件树与搜索结果行都改用它。

### 4. 本轮验证

- 类型检查通过：`cd loopra-front; node node_modules/typescript/bin/tsc -b web/tsconfig.json`。
- 单测：`node --test web/tests/*.test.mjs` **261 全过**（较上轮 255 +6：`tool-manager.test.mjs` 子代理导入 1、`git-panel.test.mjs` 相对时间/重载 1、新增 `file-icons.test.mjs` 3、`files-panel.test.mjs` 图标 1；并给 `files-panel.test.mjs` 的 lucide stub 扩到全部用到的图标、依赖表补 `'../file-icons'`）。
- 生产构建通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 真实后端 `4567`，IAB tab 22/23）：
  - 设置 → 智能体 → 子代理 → 新增角色：取消「只读角色」「继承可用工具」后出现两个导入按钮；「一键导入只读」勾选全部只读工具（排除 denied / 禁用，如 `lsp`、`submit_plan`、`goal_status`），「一键导入写入」勾选全部写入工具（排除 `sub_agent`、`ask_choice`、`goal_*` 等 denied）；随后「取消」关掉表单，未新建角色。
  - Git 页签：展开「提交作者与生成模型」存在唯一「从现有环境获取」，点击无报错；展开「提交历史」，在临时 Git 工作区渲染 `1daaa26 first commit` 行右侧显示 `T · 刚刚`（相对时间生效）。
  - 文件页签：`.workspace-tree-entry [data-icon]` 渲染出文件类型图标（`a.txt` → `default`）。
  - 全程 **0** console error、**0** `[role=alert]`。
  - 临时 Git 工作区 `_rel_test_1`（`git init` + 一次提交）验收后已 `POST /api/workspace` 切回、`DELETE /api/workspaces/b3c04ebfcdf7` 注销、删除目录；`/api/workspaces` 恢复 2 个。

### 5. 仍未迁移 / 待办（第 22 轮）

- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`、`ElementPanel.vue`、窗口控制类 `TitleBar.vue`）、Monaco 文件编辑（后端无写文件接口）、旧 `SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 视觉：设计取舍。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue。
- 直接键入的 >32KB 正文不在发送前落盘外置（旧版行为）；交互简化同前（单行 chip + 单一「清除」等）。
- 侧栏「会话批量清理 / 工作区排序与移除」入口、公式渲染端到端（真实发含 `$x$` 消息）验收。
- Git「恢复默认作者」按钮：需后端暴露默认作者常量（见本轮 §2 说明）。

## 第 23 轮（2026-10-13 续）：全量功能比对审计（回答「还差哪些功能」）

本轮不再盲猜缺口，改用三条可复核的证据线做一次系统比对，结论：**新 React 前端（`index.html` → `web/src/main.tsx`）已覆盖 legacy 的全部 Web 可达功能**；未迁移项全部属于 **Electron 渲染层**，架构上不在 React 前端职责内。

### 1. 证据线一：端点清点（legacy `services/api.js` vs `web/src`）

- 抽出 `loopra-front/src/services/api.js` 的全部请求路径，与新前端 `web/src/**` 的调用逐一比对。
- 差集里剩下的路径分两类：
  - **动态拼接误报**：`/git/{init,commit,toggle}`（`act('init')` 等）、`/mcp/servers/*`、`/lsp/servers/*`、`/extpacks/install` 都是模板字符串拼出，实际已用。
  - **legacy 里根本没被 UI 调用的死方法**：`/usage/history`、`/usage/reset`、`/sessions/import`、`/memory`、`/memory/search`、`/agent/info`、`/agent/stats`、`/jobs`、`/login`（在 legacy 组件/视图里 grep 不到任何调用）。因此不算缺口。

### 2. 证据线二：组件 / 视图逐项对照

抽查确认已迁移（每条都能在新代码里点到实现）：

- **HITL 审批**：新 `App.tsx#chooseOption` 对子代理审批走 `POST /chat/sub-hitl/{subId}`（`action: approve|deny`），与 legacy `Chat.vue#sendChoice` 一致；需求审批走 `POST /requirements/{id}/approval`。
- **会话分支**：`App.tsx#branchSession` → `POST /sessions/{name}/branch&messageCount=N`（legacy `sessionBranch.js` 的轮次边界逻辑体现在 `messageCount` 计算）。
- **会话批量清理**：`SessionsManager.tsx` 已有「全选 / 删除选中 / 清空当前工作区」；`BackendSettings.tsx` 有「清理过期会话」（`DELETE /sessions/cleanup`）与「移除项目」。
- **大段文本外置**：`Composer.tsx#handlePaste` 走 `POST /files/paste`（超过 32K 字符）；直接键入的超大正文由后端 `ChatController → PasteContentService.externalizeIfNeeded` 兜底转成折叠引用块。
- **公式渲染**：`Markdown.tsx` 引入 `remark-math`/`rehype-katex` + `normalizeMathMarkdown`，`markdown.test.mjs` 断言 `class="katex"`、行内/块级与「价格/代码不被误判」。
- **消息渲染**：`Conversation.tsx` 有「思考过程」折叠（`splitAssistantBlocks`）、修改/新增文件统计、复制/撤回/编辑/分支、长会话虚拟窗口；图片预览 `ImagePreview.tsx`、链接浮层 `LinkPopover.tsx`。
- **工作台**：`Panels.tsx` 的 4+3 个页签（工作区/文件/Git/定时/子代理/能力/环境）覆盖 legacy `RightPanel.vue`（Git/文件/定时/命令）+ 额外的子代理/能力/环境；命令页签即 `BashSessionManager` 等价物（`/agent/bash-sessions*`）。
- **设置导航**：`settings-navigation.ts` 的 15 个 section 全部在 `Settings.tsx` 有渲染分支（本轮新增守卫测试，见 §4）。
- **需求池**：浏览器实测打开 `需求池`，看板（待执行/执行中/已完成/已失败）+ 新建/刷新/关闭渲染正常。

### 3. 证据线三：明确「未迁移」及其原因（架构约束，非疏漏）

- `entry.js` 的路由是 `usesLegacyRenderer(search, !!window.electronAPI)` —— **只要存在 `electronAPI`，整包就走 Vue（`main.js`）**。也就是说新 React 前端只在浏览器环境运行，Electron 的独立窗口（`Desktop*`、`AIBrowser`、`ElementPanel`、`TerminalView`（xterm 交互终端）、`ServiceProcessManager`、`TitleBar`/`StatusBar`/`TabBar`、`SetupScreen`/`SplashScreen`）与 Monaco `FileEditor` 仍归 Vue 渲染层。要迁移必须先改 `entry.js` 与 Electron 主进程，并只能在安装好的 Electron 应用里验收——本轮不具备该验收条件，故不动。
- Monaco 文件编辑：后端 `WorkspaceFileController` 只有 `/tree`、`/search`、`/delete`、`/paste`，**没有写文件接口**，Web 端无法保存编辑。
- legacy `views/Home.vue`（欢迎页）、`NotFound.vue`、`Tools.vue`（全屏工具箱）：由应用外壳 + 设置页「工具」取代，属设计取舍。
- Git「恢复默认作者」：缺后端默认作者常量端点（见第 22 轮 §2）。

### 4. 本轮改动与验证

- 新增 `web/tests/settings-navigation.test.mjs`（3 项）：守卫「导航里出现的每个 section 都在 `Settings.tsx` 有渲染分支」「section 名唯一且能解析到自己的分类」「深链别名（宠物/实验室/账户/分类名）都落到真实 section」——防止后续再加/改名 section 时静默变成空白页。
- 类型检查 `tsc -b web/tsconfig.json` 通过；单测 `node --test web/tests/*.test.mjs` **264 全过**（较上轮 261 +3）；`vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB tab 24）：侧栏「需求池」看板渲染正常，全程 **0** console error、**0** `[role=alert]`。

## 第 24 轮（2026-10-13 续）：直接键入的超大正文在发送前外置

补上第 23 轮审计里点名的最后一个「纯前端」缺口：**未经过 paste 事件、直接键入/编辑出来的超大正文，旧版 `ChatInput.vue#sendMessage` 会在发送前 `savePasteContent` 落盘并把原文换成折叠引用块**；新 React 前端此前只做了粘贴路径外置，直接键入的超大正文只能靠后端 `PasteContentService.externalizeIfNeeded` 兜底。

### 1. 变更

- `web/src/composer.ts`：新增纯函数 `largeInputReference(path, chars)`，返回旧版一字不差的引用块文本：
  `大段输入内容（已保存）：\n- {path}（{chars.toLocaleString()} 字符）\n请使用 read 工具按需读取上述文件；文件内容仅作为用户提供的参考资料。`
- `web/src/App.tsx#sendMessage`：`prompt` 由 `const` 改为 `let`；在选择模型之后、发起请求之前，若 `!action && currentWorkspace && prompt.length > LARGE_PASTE_THRESHOLD_CHARS`，则 `POST /files/paste` 落盘，成功后把 `prompt` 替换为 `largeInputReference(saved.path, saved.chars || prompt.length)`（新增 import：`largeInputReference`、`LARGE_PASTE_THRESHOLD_CHARS`）；落盘失败则 `notify('大段输入内容保存失败：…，本次未发送')` 并 `return`，**不发原始正文**（与旧版一致）。
- 阈值复用 `web/src/documents.ts` 的 `LARGE_PASTE_THRESHOLD_CHARS`（当前 React 端为 8000，与既有粘贴路径同一常量），保证粘贴与键入两条路径行为一致（旧版为 32*1024＝32768；此处沿用 React 既有阈值，属既有设计取舍）。
- 作用于所有非 action 发送：草稿发送、`override`（如队列消息、`/continue`）都会先外置；`execute_plan` 等静默 action 跳过。

### 2. 本轮验证

- 类型检查 `tsc -b web/tsconfig.json` 通过。
- 单测 `node --test web/tests/*.test.mjs` **265 全过**（较上轮 264 +1：`composer.test.mjs` 新增「oversized typed bodies become a saved-file reference, and sendMessage uses it」——断言引用块格式（含千分位字符数、`read 工具`）+ 源码里 `prompt.length > LARGE_PASTE_THRESHOLD_CHARS`、`/files/paste`、`prompt = largeInputReference(...)` 与失败中止分支）。
- 生产构建 `vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB tab 25，切到 `defaultWorkSpace` 工作区）：
  - **粘贴路径（回归）**：对消息框 `fill()` 大段文本会走 `onPaste` → 立即落盘并在上下文里出现 `引用工作区文件：.loopra/paste/....txt`（未改动的既有路径，正常）。
  - **键入路径（本回合新增）**：用 AX `setValue` 把消息框设为 9000 字符（不触发 paste 事件，落盘文件数不变即证明未走 paste 分支），点击发送后气泡正文变为
    `大段输入内容（已保存）：\n- .loopra/paste/paste-2026…txt（9,000 字符）\n请使用 read 工具按需读取…`，磁盘上出现对应的 9000 字节 `.loopra/paste/*.txt`。
  - 全程 **0** console error、**0** `[role=alert]`。
  - 验收后：删除测试会话 `loopra-20261013072224` 与 3 个 `paste-*.txt`、`paste` 目录；`/api/workspaces` 仍为 2 个，未登记临时工作区。

### 3. 仍未迁移 / 待办（第 24 轮）

- Electron 桌面能力（`Desktop*.vue`、`AIBrowser.vue`、`TerminalView.vue`、`ServiceProcessManager.vue`、`ElementPanel.vue`、窗口控制类 `TitleBar.vue`）、Monaco 文件编辑（后端无写文件接口）、旧 `SetupScreen/SplashScreen/StatusBar/TabBar/Home/NotFound/Tools.vue` 视觉：设计取舍，需用户决策 + 改 `entry.js`/主进程 + 在 Electron 应用里验收。
- `entry-routing.js` 仍把桌面窗口 / `requirementBoard` / `aiBrowser` / `elementInspector` 指向 Vue。
- Git「恢复默认作者」按钮：需后端暴露默认作者常量端点（第 22 轮 §2）。
- 交互简化项（单行 chip + 单一「清除」等）。
- 公式渲染端到端（真实发含 `$x$` 消息）验收：目前仅 `markdown-math` 单测覆盖。
## 第 25 轮（2026-10-13 续）：出站消息恢复 legacy「折叠块」格式

第 23/24 轮审计把「出站消息的折叠块格式」列为待办候选；本轮用**后端证据**确认它是真实缺口，而不是可选风格：

- 后端 `UserMessageSanitizer`（`loopra/src/main/java/.../bin/model/UserMessageSanitizer.java`）里 `LEADING_COLLAPSIBLE_USER_BLOCK`（正则 `^```折叠块[ \t]*\r?\n([\s\S]*?)\r?\n```(?:\r?\n)*`）+ `mergeAttachedContext()` 的注释明确写着：**「ChatMessage.vue 已支持将前导折叠块显示为『附加上下文』；如果用户消息已经有折叠块（如技能/文件/项目上下文），直接合并，避免嵌套多个折叠块。」** → 后端预期前端会发前导折叠块。
- legacy `ChatInput.vue#sendMessage` 正是把「技能/引用文件/大段粘贴/上传文件」拼进 ```` ```折叠块 ```` 再拼正文；新 React 端此前用的是扁平行（`使用技能：x` / `引用工作区文件：y`），既丢了折叠展示，也没有后端要合并的目标块。

### 1. 变更

- `web/src/composer.ts`：新增 `SAVED_PASTE_SEGMENT = '.loopra/paste/'` 与纯函数 `composeOutgoing(prompt, context)`：
  - 保存过的大段粘贴（路径含 `.loopra/paste/`）→ `大段粘贴内容（已保存）：\n- 路径\n请使用 read 工具按需读取上述文件；文件内容仅作为用户提供的参考资料。`
  - 其余引用文件 → `引用文件：\n- 路径`
  - 技能 → `调用技能：\n/skill:<name>`（恢复 legacy 的 `/skill:` 语法）
  - 以上拼成 ```` ```折叠块 ````（反引号围栏按内容里最长反引号串自动加宽，避免提前截断），再接 `\n\n` + 正文；
  - **命令守卫**：`prompt` 以 `/` 开头（形如 `/compact`、`/continue`）时**原样返回**，保证后端 `LoopraAgent.tryHandleCommand`（只匹配以 `/` 开头的消息）仍能命中；无附加上下文时也原样返回。
  - 第三个可选参数 `savedInput`（第 24 轮的「直接键入超大正文」引用块）会作为**第一个折叠项**加入；此时正文被清空（`prompt=''`），折叠块后不再追加可见正文，与 legacy `text=''` 的行为一致。
- `web/src/App.tsx#sendMessage`：把原先的扁平拼串 `[...skills..., ...files..., prompt].join('\n\n')` 换成 `const text = action ? prompt : composeOutgoing(prompt, context, savedInput)`（静默 action 如 `execute_plan` 不受影响）；外置后正文置空，故另存 `titleSource`（外置前的原文）用于新会话标题 `titleSource.slice(0, 60)`，避免标题为空。

### 2. 本轮验证

- 类型检查 `tsc -b web/tsconfig.json` 通过。
- 单测 `node --test web/tests/*.test.mjs` **267 全过**（较上轮 265 +2：`composer.test.mjs` 新增「outgoing context is folded into a leading block ahead of the prompt」（含 `App.tsx` 使用点、`savedInput` 折叠、附件不计入引用断言）与「slash commands and empty context stay raw」（含围栏加宽断言））。
- 生产构建 `vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB tab 26，`defaultWorkSpace`）：对消息框 `fill()` 9000 字符触发粘贴路径 → 输入栏出现 `.loopra/paste/*.txt 9,000 字符` 上下文 chip → 发送后用户气泡出现 **「附加上下文」** 折叠标题，其内容为 ```` ```折叠块 大段粘贴内容（已保存）： - .loopra/paste/past… ````，与 legacy 一致；全程 **0** console error、**0** `[role=alert]`。
  - 直接键入超大正文（AX `setValue` 9000 字符，不触发 paste）→ 发送后气泡同样显示 **「附加上下文」** 折叠标题，内容为 ```` ```折叠块 大段输入内容（已保存）： - .loopra/paste/past… ````，正文区为空（与 legacy `text=''` 一致）；新会话标题取外置前原文前 60 字（`titleSource`）。
  - 验收后删除测试会话 `loopra-20261013073305`、`loopra-20261013073534` 与 `paste-*.txt`、`paste` 目录；`/api/workspaces` 仍为 2 个。

### 3. 仍未迁移 / 待办（第 25 轮）

- **Electron 渲染层**：本轮已用「组件引用图」复核——`AIBrowser`、`ElementPanel`（仅 `App.vue`）、`FileEditor`/`EditorTabs`/`TerminalView`/`ServiceProcessManager`/`EnvironmentPanel`/`DesktopToolPanel`（仅 `Desktop*`）在 legacy 里全部只被 Electron 外壳引用：
  - `EnvironmentPanel.vue` 的变更列表/提交记录/提交/推送**全部走 `window.electronAPI.gitEnvironment`**（`desktopGit()`），Web 端根本没有对应后端接口；legacy Web 右侧面板只有 Git/文件/定时/命令四个页签。故 React Web 端「环境」页签只保留 `GET /git/environment` + 工作树开关（已实现），**不属 Web 缺口**。
  - 结论：legacy 的全部 **Web 可达** 功能（含设置 15 个 section：常规/工具/子代理/数据面板/宠物→通用/服务器/模型渠道/项目/插件/拓展包/系统提示词/OpenAPI/MCP/LSP/关于 + 技能市场，及 Chat/RightPanel/Sidebar/Sessions/Help/RequirementBoard/SubAgents）已全部对齐，未迁移项均属 Electron 渲染层，需用户决策 + 改 `entry.js`/主进程并只能在打包 Electron 里验收。
- Git「恢复默认作者」：需后端暴露默认作者常量端点（第 22 轮 §2）。
- 公式渲染端到端（真实发含 `$x$` 消息）验收：目前仅 `markdown-math` 单测覆盖。

## 第 26 轮（2026-10-13 续）：Git「恢复默认作者」+ 子代理编辑器对齐 legacy + 公式渲染端到端验收

本轮先做了一次独立复核（不改代码）：把 legacy 的 Web 可达组件、右键菜单、工具面板与 React 端逐项对齐，未发现新的功能缺口；随后补上前 25 轮一直挂着的收尾项：Git 恢复默认作者（§1）、子代理编辑器对齐 legacy（§2）、公式渲染端到端验收（§3）。

### 1. Git 面板「恢复默认作者」（真实缺口）

- legacy `GitPanel.vue` 的提交作者区有一个 `恢复默认` 按钮（`handleResetAuthor`）：把作者重置为 Loopra 内置默认值并 `saveConfig` 落盘。React `GitTools.tsx` 之前只有「从现有环境获取 / 保存提交配置」，缺这个按钮。
- 前几轮把它判为「需后端暴露默认作者常量端点」，但实际上 legacy 就是把常量写死在前端；后端 `GitService.DEFAULT_AUTHOR_NAME`（`Loopra`）/ `DEFAULT_AUTHOR_EMAIL` 也是同一对常量，且未配置时 `GET /git/config` 会回填它们。因此前端镜像同一对常量即可，**无需改后端**。
- 改法（`web/src/components/GitTools.tsx`）：新增模块级 `DEFAULT_GIT_AUTHOR`（作者名 `Loopra`、默认邮箱、`model/modelChannelId` 置空，对应 legacy 同时清空生成模型）+ `resetAuthor()`（`setAuthor(DEFAULT_GIT_AUTHOR)` 后 `act('config', DEFAULT_GIT_AUTHOR)` 落盘）；在「从现有环境获取 / 保存提交配置」之间插入 `恢复默认` 按钮。

### 2. 子代理编辑器对齐 legacy（字段映射修复 + 渠道/模型下拉）

- 后端 `SubAgentInfoDTO`（`SubAgentController#toSubAgentInfoDTO`）返回的字段是 `systemPrompt`（不是 `instructions`），`enable` 可为 `null`，`allowedTools` 可为 `null`；legacy `SubAgents.vue#loadSubAgents` 做了 `systemPrompt→instructions`、`enable`/`allowedTools` 兜底。
- React `ResourceManagers.tsx` 之前直接用 `useRemote<Profile[]>` 渲染服务端原始对象，且 `profile.allowedTools.includes(...)` 未判空——真实后端返回的 `builtin` 角色 `allowedTools` 为 `null` 时抛 `TypeError`，**打开「设置 → 智能体 → 子代理 → 编辑」整页崩溃**（实测：IAB tab DOM 变空、页面无内容）。单测因 stub 恒返回 `[]` 未暴露该崩溃。
- 改法：新增 `ServerProfile` 类型 + `toProfile()` 映射（`systemPrompt→instructions`、`enable: profile.enable !== false`、`allowedTools ?? null`、`name` 回退 `id`），把 `state = useRemote<ServerProfile[]>` 经 `profiles` 归一化后再用于全部渲染 / 保存 / 删除路径；删除确认的载荷改成 `profiles.filter(...).map(normalizeProfile)`。
- 同时对齐 legacy `SubAgents.vue#94-154` 的「模型渠道 / 渠道模型」下拉：新增 `/models` 拉取 + `groupGitModels` 分组，默认「继承主代理（默认）」；`normalizeProfile()` 在未选渠道时剔除 `model/modelChannel`（对齐 legacy `serialize`），使「继承主代理」真正回落到主代理模型。
- 单测：`web/tests/tool-manager.test.mjs` 新增「the sub-agent editor picks channel/model from dropdowns and inherits by default」，并补 `/models` stub 与 `'../git-models'` 依赖表。

### 3. 公式渲染端到端验收（真实发消息）

- 前几轮只有 `markdown-math` 单测 + 组件 harness 覆盖。本轮在浏览器里真实发出一条含 `$...$` 与 `$$...$$` 的消息（会话 `loopra-20261013074612`），助手回复渲染出 `.katex` ×2、`.katex-display` ×1、`.katex-error` ×0，行内与块级公式均正确渲染。
- 顺带核对：legacy `utils/highlight.js` 的 texmath 用 `delimiters: 'dollars'`（只支持 `$…$`/`$$…$$`，不支持 `\(…\)`），React `normalizeMathMarkdown` 行为一致，无 `\(…\)` 缺口。

### 4. 本轮验证

- 类型检查 `tsc -b web/tsconfig.json` 通过。
- 单测 `node --test web/tests/*.test.mjs` **269 全过**（较上轮 267 +2：`git-panel.test.mjs` 新增「the git author config offers a reset to Loopra defaults」；`tool-manager.test.mjs` 新增「the sub-agent editor picks channel/model from dropdowns and inherits by default」）。
- 生产构建 `vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB tab 30，`loopra-web-ui`）：
  - 打开工作区面板 Git 页签 → 展开「提交作者与生成模型」→ 出现 `恢复默认` 按钮；点击后作者名变 `Loopra`、生成模型清空、`GET /git/config` 落盘为 Loopra 默认值；随后把作者改回原值并「保存提交配置」，`git-author.json` 已还原。全程 **0** console error、**0** `[role=alert]`。
  - 公式：见 §3，全程 **0** console error。
  - 子代理：见 §2，打开「设置 → 智能体 → 子代理」正常列出 5 个内置角色（`探索/实现/测试/审查/方案`，不再整页崩溃），点「编辑」渲染出 `角色 ID=explore` / `名称=探索` / `描述` / `模型渠道=继承主代理（默认）` / 已回填的角色提示词 / 「只读角色·启用角色」勾选；切到渠道后出现「渠道模型」下拉，点「取消」关表单不落盘。全程 **0** console error、**0** `[role=alert]`。
  - 验收后删除测试会话 `loopra-20261013074612`；`/api/workspaces` 仍为 2 个（`defaultWorkSpace` 2、`loopra-web-ui` 2）。

### 5. 仍未迁移 / 待办（第 26 轮）

- **Electron 渲染层**：与第 25 轮结论一致，属架构取舍，需用户决策 + 改 `entry.js`/主进程并只能在打包 Electron 里验收。
- 交互简化项（legacy 的分类型 chip 区 + 每个分区各自的「清除」，React 合并为单行 chip + 单一「清除」）：等价简化，非功能缺口。
- 真实写操作（排队消息发送、`/files/paste`、`/sessions/cleanup` 等破坏性入口）仍按 `docs/testing-isolation.md` 只在单测断言端点。

## 第 27 轮（2026-10-13 续）：侧栏「技能」捷径 + 右侧工作台可拖拽改宽 + 侧栏「刷新项目列表」（独立复核发现的三处真实缺口）

本轮不依赖此前结论，重新独立核对 legacy Web 入口（`legacy.html` → `src/App.vue` 的 `Sidebar`/`TitleBar`/`RightPanel`）与 React 端，抓到三处一直没补的**真实 Web 缺口**（此前被当成「设计取舍」跳过）。

### 1. 侧栏「技能」捷径（对照 `src/components/Sidebar.vue`）

- legacy `Sidebar.vue` 的快捷区固定三项：`新建任务`、`搜索`、`技能`（`@click="$emit('show-skill-market')"` → `App.vue` 里 `mainView = 'skills'`，即打开技能市场页）。
- React 侧栏动作区只有 `新建会话 / 搜索 / 会话管理 / 需求池 / 帮助中心`，**漏了 `技能`**；技能市场只藏在「设置 → 工具与集成 → 技能」里。
- 改法（`web/src/App.tsx`）：在 `搜索` 之后插入 `<button onClick={() => openSettings('技能')}><Sparkles .../>技能</button>`（中英双语文案），并从 `lucide-react` 补 `Sparkles` 图标。点击直达 `ResourceManagers#SkillManager`（已安装 + 市场搜索/浏览热门 + 安装/卸载），等价 legacy 的技能市场。

### 2. 右侧工作台可拖拽改宽（对照 `src/components/RightPanel.vue`）

- legacy `RightPanel.vue` 有 `.rp-resize-handle`：`@mousedown` 拖拽改宽，下限 `240px`、上限 `70% * window.innerWidth`，宽度写入 `localStorage['loopra-right-panel-width']`。
- React `ChangesPanel`（`web/src/components/Panels.tsx`）宽度写死在 CSS（`28.25rem / 35rem`），**不能拖拽**。
- 改法：
  - 新增 `web/src/panel-resize.ts`：`DEFAULT_PANEL_WIDTH(452)`、`WIDE_PANEL_WIDTH(560)`、`MIN_PANEL_WIDTH(240)`、`MAX_PANEL_WIDTH_RATIO(0.7)` + `clampPanelWidth()` / `resizePanelWidth()`（左拖变宽，边界钳制）。
  - `Panels.tsx`：宽度走 `useLocalState('right-panel-width', 452)` 持久化；仅 `docked`（`matchMedia('(min-width: 1101px)')`）时应用定宽并渲染 `.panel-resize-handle`（≤1100px 面板是浮层，保持响应式）；拖拽用 window 级 `mousemove/mouseup`；「展开工作区面板」在 452/560 间切换。
  - `workbench.css`：`.changes-panel { position: relative }` + `.panel-resize-handle`（左缘 8px、`ew-resize`、悬停/拖拽高亮）。

### 3. 侧栏「刷新项目列表」（对照 `src/components/Sidebar.vue`）

- legacy `Sidebar.vue` 工具行在 `按最新排序` 之后还有一个 `刷新项目列表`（`@click="$emit('refresh-workspaces')"` → `App.vue` 重新拉取工作区 / 会话列表）。
- React `.section-label` 动作行只有 `定位当前会话 / 折叠工作区 / 按最新排序`，**漏了 `刷新项目列表`**。
- 改法（`web/src/App.tsx`）：在 `按最新排序` 之后插入 `<IconButton label="刷新项目列表" onClick={() => void backend.refresh()}><RefreshCw size="0.875rem" /></IconButton>`（`RefreshCw` 已在 imports 中）。

### 4. 本轮验证

- 类型检查 `tsc -b web/tsconfig.json` 通过。
- 单测 `node --test web/tests/*.test.mjs` **273 全过**（较上轮 269 +4：新增 `panel-resize.test.mjs` 4 项——侧栏技能捷径接线、**刷新项目列表接线**、拖拽实现接线、宽度钳制（240 / 70% / 方向）；并给 `terminal-panel.test.mjs` 依赖表补 `'../lib'`、`'../panel-resize'` stub）。
- 生产构建 `vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB tab 32）：
  - 侧栏出现 `技能`（`搜索` 与 `会话管理` 之间）；点开直达设置「技能」页：`技能市场 / 已安装 / 技能市场（默认市场 · skillhub.cn · clawhub.ai）/ 搜索技能 / 搜索 · 浏览热门`。
  - 右侧工作台面板出现 452px 定宽 + 拖拽手柄；`drag [828,121]→[700,121]` 后宽度 452→580、`className` 变 `changes-panel wide`；**刷新页面后重新打开仍为 580**（localStorage 持久化生效）；再拖回 452 还原。
  - 侧栏工具行出现 `刷新项目列表`；点击后 `tab.dev.logs` 无新增报错，工作区（`defaultWorkSpace` / `loopra-web-ui`）与会话列表保持正常。
  - `tab.dev.logs({levels:['error','warning']})` 全程 **0** 条；`[role=alert]` 0 个。

### 5. 仍未迁移 / 待办（第 27 轮）

- **Electron 渲染层**：与第 25/26 轮结论一致，属架构取舍，需用户决策 + 改 `entry.js`/主进程并只能在打包 Electron 里验收。
- 开源主页 Star 链接：legacy 放在 `TitleBar.vue`，React 已挪到「设置 → 关于」（`Settings.tsx` 的 `about-community`），属有意重排，未回迁顶栏。
- 真实写操作（排队消息发送、`/files/paste`、`/sessions/cleanup` 等破坏性入口）仍按 `docs/testing-isolation.md` 只在单测断言端点。

## 第 28 轮（2026-10-13 续）：DiffView「旧版本 / 新版本」表头 + 全量字符串复核

本轮先复查上一轮遗留的「刷新项目列表」按钮（浏览器点按无报错、工作区/会话列表正常），再独立重跑一次 legacy→React 的中文串覆盖审计（`loopra-front/src/**` 的中文串 vs `web/src/**` 语料，剔除 Electron 专属组件与 `*.test.js`）。结论：**除 Electron 渲染层外，剩余差异几乎全是措辞差异**（旧版「源代码管理 / 变更 / 历史提交 / 未跟踪文件」，React 版「Git / 个改动 / 提交历史」等），非功能缺口。

### 1. 复核：侧栏「刷新项目列表」（确认上一轮落地）

- 浏览器（IAB tab 34）：侧栏工具行五个按钮 `定位当前会话 / 折叠工作区 / 按最新排序 / 刷新项目列表` 齐全；点按 `刷新项目列表` 后工作区（`defaultWorkSpace` / `loopra-web-ui`）与会话列表保持正常，`tab.dev.logs` 无新增报错。

### 2. 真实缺口：DiffView 缺少「旧版本 / 新版本」列头（对照 `src/components/DiffViewer.vue`）

- legacy `DiffViewer.vue` 在 diff 视图顶部固定一行 `.diff-sbs-header`：`旧版本`（左）/`新版本`（右），并让 `handleBodyScroll` / hunk 跳转按表头高度补偿滚动偏移。
- React `web/src/components/DiffView.tsx` 只有导航条 + 行，**漏了表头**，且 hunk 跳转/滚动高亮未补偿表头高度。
- 改法：`DiffView.tsx` 在 `.diff-sbs` 内插入 `<div className="diff-sbs-header"><span className="diff-sbs-label">旧版本</span><span className="diff-sbs-label">新版本</span></div>`；`navigate()` 与 `handleScroll()` 用 `.diff-sbs-header` 的 `clientHeight` 补偿偏移（对齐 legacy）。`workbench.css` 新增 `.diff-sbs-header`（sticky 顶栏）/`.diff-sbs-label` 样式。

### 3. 本轮验证

- 类型检查 `tsc -b web/tsconfig.json` 通过。
- 单测 `node --test web/tests/*.test.mjs` **274 全过**：`web/tests/diff.test.mjs` 新增一项 **jsdom 真实挂载 `DiffView`** 用例（注入样例 diff，断言 `.diff-sbs-header` 存在、含 `旧版本`/`新版本` 文案、且位于 `.diff-sbs-row` 之前），并断言 `workbench.css` 含对应规则。
- 生产构建 `vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（IAB tab 34）：页面重载后工作区面板六个页签（`文件 / Git / 定时 / 子代理 / 能力 / 环境`）正常；`tab.dev.logs`（error+warning）**0** 条，`[role=alert]` 0 个。当前两个工作区均无 git 改动，故表头走的是「该文件没有未提交的改动」分支，未在真实 diff 上肉眼验收（由上述 jsdom 用例覆盖渲染）。

### 4. 仍未迁移 / 待办（第 28 轮）

- **Electron 渲染层**（第 25–28 轮一致结论）：Desktop* / TitleBar / Splash / Setup / AIBrowser / ElementPanel / ServiceProcessManager / xterm TerminalView / Monaco FileEditor 归 Vue，属架构取舍，需用户决策后改 `entry.js` 与主进程，且只能在打包 Electron 内验收。
- 审计中确认属「措辞差异 / 有意重排」而非缺口的项：Git 面板文案、`中文字体`（legacy 仅桌面端）、`开源主页 Star`（React 放在「设置 → 关于」）、Markdown 告警框 / 图片放大预览（React 已实现）。

## 第 29 轮（2026-10-13 续）：Electron 无边框标题栏（React 接线）+ `?react=1` 逃生舱

本轮处理第 25–28 轮一直挂着的「Electron 渲染层」待办里**唯一能纯前端落地**的一项：主窗口的无边框标题栏。不改主进程、不改默认路由行为（零回归），只给 React 渲染器补上标题栏，并加一个显式开关让 Electron 主窗口可选地加载 React。

### 1. 真实缺口：Electron 主窗口在 React 下没有标题栏/窗口按钮

- `electron/main.cjs` 主窗口是 `frame:false` + `titleBarStyle:'hidden'`（自绘 chrome），IPC 已有 `window-minimize` / `window-maximize` / `window-close` / `window-is-maximized`；`electron/preload.cjs` 暴露 `window.electronAPI.window.*`、`isElectron`、`platform`。
- legacy 用 `TitleBar.vue` 自绘标题栏 + 最小化/最大化/关闭；React 版**完全没有对应组件**——一旦主窗口走 React，就没有可拖拽区域和窗口按钮，无法最小化/关闭。

### 2. 改法（全部为新增文件 / 现有文件接线，未改主进程）

- 新增 `web/src/desktop-shell.ts`：`desktopWindowApi()`（仅当 `window.electronAPI.window` 同时具备 minimize/maximize/close 才算桌面）、`isDesktopWindow()`、`desktopPlatform()`、`windowControlsOnLeft()`（macOS 左侧）。
- 新增 `web/src/components/DesktopTitleBar.tsx`：无 bridge 时 `return null`（浏览器里彻底不渲染）；有 bridge 时渲染 `-webkit-app-region: drag` 标题栏 + 最小化/最大化(还原)/关闭，调 `electronAPI.window.*`，最大化态用 `isMaximized()` 决定图标/文案（「最大化窗口」/「还原窗口」）。**注意：本环境无法交互验收 Electron 窗口，已用 jsdom + 打桩 bridge 覆盖渲染与回调。**
- `web/src/App.tsx`：根节点改为 `<div className={`desktop-app${isDesktopWindow() ? ' is-desktop-shell' : ''}`}>`，并在其前 `{isDesktopWindow() && <DesktopTitleBar />}`。
- `web/src/styles.css`：新增 `.desktop-titlebar`（drag）/`.desktop-titlebar-title`/`.desktop-titlebar-spacer`/`.desktop-window-controls`（no-drag）/`.dw-btn`/`.dw-btn.dw-close:hover`（红）/`.desktop-app.is-desktop-shell`。
- `src/entry-routing.js`：重构为 `ELECTRON_AUXILIARY` 常量（desktopSplash/Update/Onboarding/ChatTab/Search/Message/Popup/Pet/requirementBoard/aiBrowser/elementInspector 这些窗口仍走 Vue）；新增**逃生舱**——`?react=1` 且非辅助窗口时 `usesLegacyRenderer` 返回 `false`（Electron 主窗口可走 React）。`desktop`/辅助窗口/`desktopShell=1` 行为不变，默认桌面仍走 Vue（零回归）。

### 3. 本轮验证

- 类型检查 `tsc -b web/tsconfig.json` 通过（exit 0）。
- 单测 `node --test web/tests/*.test.mjs` **281 全过**：新增 `web/tests/desktop-shell.test.mjs` **7 项**——bridge 探测、平台默认 win32 / macOS 控件靠左、App 接线（仅在桌面渲染标题栏与 `is-desktop-shell`）、标题栏 drag/no-drag CSS、`entry-routing` 分支（`?react=1` 放行 React、辅助窗口不受影响）、**jsdom 真实挂载**（无 bridge 输出空、有 bridge 渲染三控件且 `isMaximized()` true 时按钮为「还原窗口」）。
- 生产构建 `vite build` 通过（仅既有 chunk 体积警告）。
- 浏览器验收（dev `3000` → 后端 `4567`，IAB tab 37）：`.desktop-titlebar` 计数 **0**、`.desktop-app.is-desktop-shell` 计数 **0**、`typeof window.electronAPI === 'undefined'`、`[role=alert]` **0**、`tab.dev.logs({levels:['error','warning']})` **0** 条——即标题栏在浏览器里完全惰性，无回归。

### 4. 仍未迁移 / 待办（第 29 轮）

- **Electron 主窗口走 React 的端到端验收**：接线已完成，但 `desktopShell=1`（现默认）仍走 Vue；要真正切到 React 需在打包 Electron 里用 `?react=1` 打开并核对拖拽/最小化/最大化/关闭，**本环境无 GUI 无法确认**（`electron.exe` v42.8.1 存在但 `electron --version` 无输出）。需用户决策是否把默认渲染器切成 React。
- **辅助窗口 / 深层桌面能力**（第 25–29 轮一致）：Desktop* / Splash / Setup / AIBrowser / ElementPanel / ServiceProcessManager / xterm TerminalView / Monaco FileEditor 仍归 Vue，属架构取舍。
- 真实写操作（排队消息发送、`/files/paste`、`/sessions/cleanup` 等破坏性入口）仍按 `docs/testing-isolation.md` 只在单测断言端点。

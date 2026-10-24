# Claude Code ACP 接入

主聊天可以选择 Loopra Native 或本机 Claude Code。两者复用 ACP Client、工具卡片、
审批和停止流程；Claude Code 使用独立进程和自己的登录、模型与项目配置。

已有会话可在相同执行环境中复用已初始化的 ACP 适配器。会话内的 Claude CLI、
配置、审批与输出继续独立，因此这项优化省去外层握手，仍保留 CLI 的初始化成本。
诊断字段与实测见 [启动耗时诊断](acp-startup-diagnostics.md)。

## 使用

1. 安装 Node.js 22+、Claude Code，并确认终端里的 Claude 可以正常对话。
2. 安装社区维护的 ACP 适配器：

   ```sh
   npm install -g @agentclientprotocol/claude-agent-acp@0.93.0
   ```

3. 重新构建并启动 Loopra 后端、刷新前端。在输入框旁的「选择 Agent」中选择
   **Claude Code**，新建会话后发送任务。Vue 旧版界面在聊天顶部选择 Agent。
4. 工具需要授权时，在现有审批面板中选择 Agent 提供的选项。Native 的“完全自动”
   配置不会自动放宽 Claude 的权限。

适配器项目：<https://github.com/agentclientprotocol/claude-agent-acp>。
安装检测只表示启动文件存在，不表示登录有效；登录和模型错误会通过聊天流返回。

## 安装检测

后端查找 `node`、`claude` 和全局 npm 安装的适配器。支持 Windows `Path` 大小写、
NVM_BIN、NVM_SYMLINK、NODE_HOME、NPM_CONFIG_PREFIX、APPDATA/npm、用户
`.local/bin`、`.npm-global/bin`、`.nvm/current/bin`，以及 macOS/Linux 的
`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` 和 `/bin`。桌面启动的后端
可能没有继承终端的 PATH，这些标准目录用作兜底；不会枚举 NVM 的多个版本来猜测当前版本。
NVM 安装需要继承 `NVM_BIN` / PATH、提供 `current` 链接，或设置 Node 路径。
后端通过参数列表直接启动 Node，不拼接 shell 命令，支持带空格的路径。
原生安装和 npm 全局安装均会自动识别。npm 安装按 `@anthropic-ai/claude-code/package.json`
里的 `bin` 声明解析真实入口，兼容原生二进制和 JavaScript CLI；Windows 的
`claude.cmd` / `claude.ps1` 不会被直接传给 SDK，避免检测通过后仍无法启动。
Unix 符号链接会解析到真实入口，原生程序需要执行权限；适配器命令的符号链接也可
指向其他前缀。启动时将检测到的 Node 和 Claude 所在目录加入子进程 PATH，兼容
JavaScript CLI 和 `/usr/bin/env node`，不修改用户的系统环境变量。

特殊安装位置可在启动后端前设置：

- `LOOPRA_NODE_EXECUTABLE`：Node 可执行文件绝对路径。
- `CLAUDE_CODE_EXECUTABLE`：Claude Code 可执行文件绝对路径。
- `LOOPRA_CLAUDE_ACP_SCRIPT`：适配器 `dist/index.js` 绝对路径；也支持 JVM 参数
  `-Dloopra.claude.acp.script=...`。

`GET /api/agent-engines` 返回可用状态和具体缺失项。React 每次打开 Agent 菜单都会
重新检测。安装后若 IDE 或桌面后端没有继承新的环境变量，应重新启动后端进程。

## 会话与进程

工作台 `.meta` 保存 `agentId`、`acpSessionId` 和 `acpCwd`，JSONL 保存可展示的对话和
工具记录。已有消息的会话不能切换 Agent，避免混用不同引擎的上下文。

每个 Claude 会话复用一个 ACP stdio 连接；最多保留 8 个连接，达到上限时关闭最近
最少使用的空闲连接。后端重启或连接被回收后，使用 `session/load` 恢复远端上下文，
不重复写入回放的历史。恢复失败会明确报错，不会静默新建空会话。

进程异常退出会立即结束等待中的请求。关闭连接时清理所启动的进程及其子进程。
隔离分支会话使用现有 Worktree 的执行目录，并校验恢复时的目录一致性。

## 托管 MCP

Claude Code 会话通过 ACP v1 的 `session/new` / `session/load` 接收 Loopra 管理的
全局 `~/.loopra/mcp-servers.json` 和当前项目 `.loopra/mcp-servers.json`。
兼容 `servers` 数组及标准 `mcpServers` 对象；同名服务器以项目配置为准，项目中
`enabled: false` 可屏蔽同名全局服务器，禁用项不会发送给 Agent。

stdio 的 command、args、env 及 HTTP/SSE 的 URL、headers 按协议传递；
`streamable` / `streamable_stateless` 转为 ACP 的 `http`。发送前检查 Agent 的
`mcpCapabilities`，不支持的传输会明确报错。工具执行审批仍由 Claude 的权限模式负责；
Loopra Native 的工具禁用、只读覆盖和服务端自定义超时不属于 ACP 配置字段，不会传给 Claude。

每轮及读取 Agent 配置时重新检查 MCP 配置。配置变化会在会话空闲时重建连接，并通过
`session/load` 恢复已有远端会话；正在运行的回合不被中途替换。隔离分支使用主项目
的托管配置、会话执行目录作为 ACP cwd。其他项目和关联项目的 MCP 不自动合并。

## 当前范围

支持 ACP v1、多轮文字/图片、工具参数更新与结果、审批、取消、本地历史和重启恢复。
不要求配置 Loopra Native 的模型密钥才能使用已安装的 Claude。

Claude 模型沿用其自身配置，Native 的模型/思考强度/快速模式选择不会传给 Claude。
外部 Provider 注册器已供 Claude 和 [Codex](acp-codex.md) 共用；模型/模式等配置按
Agent 上报的选项展示。可编辑启动配置和认证向导仍待后续补充。
Claude 的扁平子任务转录可在现有子代理面板显示和回放。
外部 ACP 共用的表单提问也已接入 React/Vue：选择项或填写答案后恢复原请求，
不新增用户消息；权限审批与问答使用各自的请求 ID。React 另显示 Agent 上报的
计划进度和斜杠菜单，并持久化供刷新恢复。回合结束原因保留取消、上限和拒绝的区别。

定时任务、需求执行等 Native 专用入口尚未切换到 Claude。Native 的回滚上下文、
系统提示词和计划审批接口不适用于 Claude 会话，会明确拒绝。

## 验证

普通测试 `ExternalAcpSessionsTest` 启动确定性的 Java ACP 子进程，验证多轮、恢复、
工具参数更新、批准、拒绝、取消和进程退出，不使用真实账号或模型。
`ClaudeAcpProcessTest` 验证 Windows `Path`、NVM、APPDATA、npm 原生/JavaScript
入口、显式 shim 路径、Unix npm 布局，以及缺失或损坏安装的检测。
还覆盖 Apple Silicon / Intel Homebrew 目录布局、NVM、npm 自定义前缀，以及
在 Linux/macOS 上实际执行的符号链接、执行权限和子进程 PATH 测试。
CI 的后端检查包含 Windows、Ubuntu 和 macOS；布局测试不代表真实账号推理联调。

真实联调需显式开启；它使用现有 Claude 登录和真实推理，文件操作只发生在临时项目，
Loopra 数据仍由测试隔离目录管理：

```sh
mvn -pl loopra -am test -Dtest=ClaudeAcpSmokeTest -Dloopra.test.claude=true -Dsurefire.failIfNoSpecifiedTests=false
```

联调覆盖多轮上下文、后端服务重建后恢复、读取临时文件、审批后写入临时文件，
并检查没有构造 Native Agent。普通测试不会自动调用真实 Claude。

# Codex ACP 接入

主聊天支持 **Loopra Native / Claude Code / Codex**。外部 Agent 共用 ACP 客户端、
进程池、工具卡片、审批、取消、MCP 和本地历史，各自保存远端会话身份与配置。

## 安装与使用

在运行 Loopra 后端的机器上安装 Node.js 22+ 和维护中的适配器（本次验证版本为 2.2.2）：

```sh
npm install -g @agentclientprotocol/codex-acp@2.2.2
codex-acp --version
```

适配器自带兼容的 `@openai/codex`，无需额外安装另一个 CLI。已有的 Codex 登录和
配置继续有效；首次使用可通过适配器自带 CLI 登录：

```sh
codex-acp cli login
```

重新构建并启动 Loopra 后端、刷新前端，在「选择 Agent」中选择 **Codex** 后新建会话。
未检测到依赖时，菜单提供 Codex 专用的安装提示词。检测成功表示安装入口存在，
不代表登录有效；认证、模型和子进程错误会通过聊天返回。本阶段使用现有登录，
不提供 Loopra 内的登录向导。

上游项目：[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)。
它将 ACP stdio 转换为 [Codex app-server](https://developers.openai.com/codex/app-server)；
旧 `@zed-industries/codex-acp` 已迁移，不作为本次接入的检测目标。

## 安装检测与配置

Claude 与 Codex 共用 Node/npm 搜索目录：继承的 PATH、NVM、NODE_HOME、APPDATA/npm、
npm 自定义前缀、用户 `.local/bin` / `.npm-global` / `.nvm/current/bin` 和 Unix 标准目录。
按参数列表直接启动 `node <adapter>/dist/index.js`，兼容带空格的路径，不依赖 shell 或
Windows npm shim。后端的 `GET /api/agent-engines` 按注册的 Provider 返回安装状态。

特殊安装位置可配置：

- `LOOPRA_NODE_EXECUTABLE`：Node 可执行文件路径。
- `LOOPRA_CODEX_ACP_SCRIPT`：Codex ACP `dist/index.js` 路径。
- JVM 参数 `-Dloopra.codex.acp.script=...`：优先于脚本环境变量。

子进程继承 Codex 的 `CODEX_HOME`、`CODEX_PATH`、`MODEL_PROVIDER`、`CODEX_CONFIG`
等环境变量；只有需要指定另一版本 CLI 时才使用上游的 `CODEX_PATH`。工作台不会
写入用户的 Codex 配置或自动设置完全访问模式。

模型、思考强度、快速模式和权限模式来自 Agent 的 `configOptions`，使用现有配置控件。
具体可选值和是否提供某项配置取决于适配器、CLI 和账户。Native 模型设置不会传给 Codex。

## 会话与能力边界

每个外部会话绑定一个 Provider 和工作目录，远端 ID、Agent 配置、展示历史分别持久化。
重启、空闲进程回收或 MCP 配置变化后使用 `session/load` 恢复；恢复失败明确报错。
进程上限由所有外部 Provider 共享，当前为 8 个连接。
已有消息或已建立远端绑定的会话不能切换 Agent；空会话重置隔离目录时保留原 Agent 标识。

支持 ACP v1 的多轮文字、图片、工具活动、权限审批、取消及 Agent 上报的用量。
托管 MCP 与 Claude 使用同一套全局/项目合并规则；2.2.2 的 Codex 适配器声明支持
stdio 和 HTTP、不支持 SSE。遇到不支持的传输会明确报错。

Codex 在 initialize 协商原生子会话能力；子代理及嵌套子代理的文本、思考、工具和
完成状态转换为工作台子代理事件，支持实时展示、右侧面板回放及 session/load 历史重建。
未声明该能力、或握手字段被适配器 SDK 过滤时，从 `spawnAgent` / `wait` 等协作工具的
真实子线程 ID、状态及最终答复生成子代理标签与回放；该回退不包含上游未发送的内部
工具和思考过程。重新打开会话时恢复已保存的子代理标签。Claude 继续沿用扁平子任务转录。
上游 2.2.2 不支持单独取消或关闭子会话，工作台取消仍作用于根会话。

客户端声明 ACP 表单提问能力，接收 `elicitation/create`：选择题、补充文本、数值、
布尔及多选通过独立问答面板回答；提交会恢复原 RPC，不新增聊天回合。待答问题可在
刷新后恢复，跳过、超时、停止会释放等待；答案不额外写入本地提问事件。URL elicitation
未声明支持。Codex 的提问工具是否可用仍由其 CLI/模式决定；React 的计划模式开关
已对应 Codex `collaboration_mode` 的 `default` / `plan`，不会调整文件访问权限。

标准 `plan`、`available_commands_update` 保存在会话元数据。React 主聊天显示 Agent
上报的任务进度和斜杠菜单，切换会话或刷新后恢复；不会混入 Native 的技能命令。
回合结束会区分正常结束、取消、输出/请求次数上限和拒绝，上限与拒绝另行提示。
定时任务、需求执行、Native 上下文回滚及 Native 专用计划接口不在本次迁移范围。

## 验证

普通测试不调用真实模型：

- `CodexAcpProcessTest`：安装路径、npm 布局、显式入口和子进程环境。
- `ExternalAcpSessionsTest`：针对 Claude/Codex 标识验证多轮、恢复、MCP、配置、审批、取消和进程退出。
- `CodexSubAgentSessionsTest`：原生子会话协商、嵌套、审批、取消、失败、历史重建与旧版回退。
- `AcpElicitationsTest` / `ExternalAcpInteractionTest`：结构化问答、跳过/取消/超时、计划与命令持久化及结束原因。
- `ExternalAgentRoutingTest`：工作台实际路由、Provider 配置隔离、重启恢复及空会话隔离重置。
- 现有 Claude 安装检测、Native ACP、进程释放和 Native 回合测试继续回归。

真实适配器协议握手不使用账户或推理，隔离 `CODEX_HOME` 后运行：

```sh
mvn -pl loopra -am test -Dtest=CodexAcpProtocolSmokeTest -Dloopra.test.codex.protocol=true -Dsurefire.failIfNoSpecifiedTests=false
```

真实推理测试需显式启用，使用已有 Codex 登录，在临时项目内验证多轮、重启恢复、读写文件及审批：

```sh
mvn -pl loopra -am test -Dtest=CodexAcpSmokeTest -Dloopra.test.codex=true -Dsurefire.failIfNoSpecifiedTests=false
```

Windows PowerShell 中请将每个 `-D...` 参数放在单引号内，避免带点的属性名被拆分。

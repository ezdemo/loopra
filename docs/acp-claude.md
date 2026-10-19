# Claude Code ACP 接入

主聊天可以选择 Loopra Native 或本机 Claude Code。两者复用 ACP Client、工具卡片、
审批和停止流程；Claude Code 使用独立进程和自己的登录、模型与项目配置。

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
NVM_SYMLINK、NODE_HOME、APPDATA/npm、用户 `.local/bin`，以及 macOS/Linux 的
`/opt/homebrew/bin` 和 `/usr/local/bin`——IDE 或桌面方式启动的后端继承的是
launchd 的最小 PATH，不认识 Homebrew 目录，这两个兜底路径可以避免误报缺少 Node.js。
后端通过参数列表直接启动 Node，不拼接 shell 命令，支持带空格的路径。

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

## 当前范围

支持 ACP v1、多轮文字/图片、工具参数更新与结果、审批、取消、本地历史和重启恢复。
不要求配置 Loopra Native 的模型密钥才能使用已安装的 Claude。

Claude 模型沿用其自身配置，Native 的模型/思考强度/快速模式选择不会传给 Claude。
通用注册器、可编辑启动配置、认证向导、动态模型/模式配置和独立子 Agent 面板仍待
后续补充。Claude 子任务当前按适配器提供的普通工具活动显示。

定时任务、需求执行等 Native 专用入口尚未切换到 Claude。Native 的回滚上下文、
系统提示词和计划审批接口不适用于 Claude 会话，会明确拒绝。

## 验证

普通测试 `ExternalAcpSessionsTest` 启动确定性的 Java ACP 子进程，验证多轮、恢复、
工具参数更新、批准、拒绝、取消和进程退出，不使用真实账号或模型。
`ClaudeAcpProcessTest` 验证 Windows `Path` 和 NVM 检测。

真实联调需显式开启；它使用现有 Claude 登录和真实推理，文件操作只发生在临时项目，
Loopra 数据仍由测试隔离目录管理：

```sh
mvn -pl loopra -am test -Dtest=ClaudeAcpSmokeTest -Dloopra.test.claude=true -Dsurefire.failIfNoSpecifiedTests=false
```

联调覆盖多轮上下文、后端服务重建后恢复、读取临时文件、审批后写入临时文件，
并检查没有构造 Native Agent。普通测试不会自动调用真实 Claude。

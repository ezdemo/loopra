# Pi / DeepSeek Harness ACP 接入

主聊天的「选择 Agent」支持 **Pi**（`pi`）和 **DeepSeek Harness**（`dsh`）。
它们复用外部 ACP 会话、工具活动、取消、审批、模型配置和本地历史；可用配置由 Agent 上报。
在后端所在机器安装并配置依赖后，重新构建启动后端、刷新前端即可选择对应 Agent 新建会话。
已有消息或远端绑定的会话不能直接切换引擎。

## Pi

使用 [svkozak/pi-acp](https://github.com/svkozak/pi-acp) 将 ACP stdio 桥接到 `pi --mode rpc`。
安装 Node.js 22+、Pi CLI 和适配器（接入时核对适配器版本为 0.0.34）：

```sh
npm install -g @earendil-works/pi-coding-agent pi-acp
pi
```

在 Pi 中完成登录和模型配置，再返回 Loopra。后端同时检测 Pi CLI 和 ACP 适配器；
检测成功只表示入口存在，认证和模型可用性由实际请求验证。
Windows 通过 Node 直接运行适配器，再通过上游 `PI_ACP_PI_COMMAND` 指定找到的 Pi CLI，
兼容 npm 的 `pi.cmd`、带空格的路径和桌面进程缺少 npm PATH 的情况。

特殊位置可用 `LOOPRA_PI_ACP_SCRIPT` 或 JVM 参数 `-Dloopra.pi.acp.script=...`
指定适配器 JS 入口，用 `PI_ACP_PI_COMMAND` 指定 Pi 可执行命令或绝对路径。

上游 `pi-acp` 当前接收 MCP 参数但没有转发到 Pi。Loopra 遇到启用的工作台 MCP 会明确报错，
避免工具被静默丢弃；请先停用工作台 MCP，再在 Pi 中配置所需扩展。
思考流、权限及其他功能以适配器实际提供的 ACP 能力为准。

### Pi 的配置与指令

模型和思考强度来自 Agent 的 `configOptions`，已映射到输入框的模型、推理控件。
Pi 的旧 `session.modes` 也是思考强度，不是文件访问权限或标准/极简工具模式。
当前适配器没有暴露 `--tools`、`--no-extensions` 等 Pi CLI 参数；不能直接将这些参数
附加到 `pi-acp`，它是另一个程序。

在输入框输入 `/` 可选择 Pi 上报的指令：

| 指令 | 作用 |
|---|---|
| `/compact [要求]` | 手动压缩上下文；可能调用模型 |
| `/autocompact on`、`/autocompact off` | 开关自动压缩；不带参数会切换开关 |
| `/steering all`、`/steering one-at-a-time` | 设置 Pi 对插入消息的投递方式 |
| `/follow-up all`、`/follow-up one-at-a-time` | 设置 Pi 对后续消息的投递方式 |
| `/session`、`/name 名称`、`/export` | 查看统计、命名、导出会话 |

`/steering` 和 `/follow-up` 不带参数时只查询当前值。它们控制 Pi 自己的消息投递策略，
不会改变 Loopra 工作台自己的消息队列。可用指令由当前安装的适配器上报，
Loopra 通过现有 ACP 命令菜单发送并保存其结果。

当前桥接器还会读取 `~/.pi/agent/settings.json` 与项目的 `.pi/settings.json`：
`quietStartup: true` 可隐藏启动信息块（版本更新提示仍可能显示），
`enableSkillCommands: true` 允许在 `/` 菜单显示 `/skill:技能名`，默认已开启。
这些是 Pi/适配器自己的配置；Loopra 沿用它们，不另写一份互相覆盖的设置。
`PI_CODING_AGENT_DIR` 可指定另一套 Pi Agent 配置目录，后端子进程会继承该环境变量。

## DeepSeek Harness

使用 [官方 ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)，
启动方式为 `dsh --profile acp`。安装提供该 profile 的 `@deepseek-ai/dsh` 版本，
并按该版本要求安装 Node.js（接入时官方 master 要求 24.9+）。
先检查 `dsh --profile acp --help`；部分较早的 npm 版本没有当前源码的 ACP 能力，
必要时按官方说明构建源码，不应仅依据包版本或 CLI 文件存在判断协议支持。

后端读取 `@deepseek-ai/dsh/package.json` 的 `bin.dsh`，按参数列表执行：

```text
node --import <日志重定向 preload> <dsh 的 JS 入口> --profile acp
```

自定义安装或源码构建使用 `LOOPRA_DSH_ACP_SCRIPT` 或 JVM 参数
`-Dloopra.dsh.acp.script=...` 指向**构建后的 CLI JS 入口**。
共享 `LOOPRA_NODE_EXECUTABLE` 可指定 Node 路径。子进程继承本机 DSH 配置与凭据，
Loopra 不会把 Native 模型渠道转换为 DSH 配置。

启动引导代码在加载 CLI 前将 `console` 的普通日志转到 stderr；ACP JSON-RPC
仍通过 stdout 传输。这样 DSH 模型列表插件的 `console.info` 不会混入协议流，
避免在 `session/new` 时被误判为通信中断。CLI 参数、工作目录和用户配置保持原有语义。

DSH 支持 `session/resume`，不支持 `session/load` 或历史事件回放。连接重建后，
Loopra 根据协商能力恢复远端上下文，同时保留本地聊天历史；不会改为新会话来掩盖恢复失败。
模型和推理配置使用 Agent 的 `configOptions`。MCP 支持 stdio / HTTP，SSE 会明确拒绝。
当前官方 ACP profile 只支持一个主工作目录，关联项目目录会明确报错；
不提供会话分叉、计划、命令、结构化提问或专用子代理展示。

### DSH 的标准 / 极简等预设

DSH Web 的标准（`standard`）、极简（`minimal`）、PTC（`ptc`）、创造（`cordis`）
是 Agent 组合预设，会影响工具、提示词和插件。官方 ACP 当前只上报模型与推理强度，
没有预设选择接口，`dsh --profile acp --help` 也没有对应参数。
`sdk-minimal` 是另一套 SDK 协议的运行 profile，不能用它替换 `acp` 后继续通过 ACP 通信。
因此 Loopra 不在官方 ACP 会话里添加无法生效的标准/极简开关。
参考 [官方预设界面说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/README.zh.md)
及 [官方 ACP 能力范围](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)。

## 从此回复继续到新会话

当前 `svkozak/pi-acp` 0.0.34 和官方 DSH ACP 均未声明 `sessionCapabilities.fork`，
因此这两个引擎不显示“从此回复继续到新会话”按钮。
Pi CLI 自身的分叉能力没有被当前 ACP 适配器暴露，DSH 的其他界面/SDK 能力也不能
直接视为 ACP 能力。

另一个社区 Pi 适配器 `@victor-software-house/pi-acp` 提供整段会话的 fork，
但当前实现没有解析“选定历史回复”的定位信息；不能用它来实现该按钮，
否则新会话可能包含所选回复之后的内容。
Loopra 没有自动替换已安装适配器或改用本地转录假装恢复了远端上下文。

## 验证

`PiDshAcpProcessTest` 覆盖 npm bin 元数据、Windows / Unix 安装布局、显式入口、
Pi 依赖检测及子进程配置。`ExternalAcpSessionsTest` 和 `ExternalAgentRoutingTest`
使用真实 stdio 测试进程验证两种 Agent 的路由、配置、恢复、本地历史及能力边界，
包括只支持 resume 的 DSH；不调用真实模型或账户。
前端 `agent-install.test.mjs` 验证安装提示。

安装 DSH 后可显式运行真实协议测试（读取已有 DSH 配置，不发送模型 prompt）：

```sh
mvn -pl loopra -am test -Dtest=DshAcpProtocolSmokeTest -Dloopra.test.dsh.protocol=true -Dsurefire.failIfNoSpecifiedTests=false
```

该测试验证真实插件加载、配置选项、新建和恢复会话。Windows PowerShell 请用单引号
分别包住每个 `-D...` 参数。

Pi 的真实协议测试读取已有 Pi 配置，验证模型/思考选项、斜杠菜单和不调用模型的
`/steering`、`/follow-up` 查询，并核对当前适配器没有分叉能力：

```sh
mvn -pl loopra -am test -Dtest=PiAcpProtocolSmokeTest -Dloopra.test.pi.protocol=true -Dsurefire.failIfNoSpecifiedTests=false
```

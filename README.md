<h1 align="center">Loopra</h1>

<p align="center">
  <img src="img/logo.png" alt="Loopra logo" width="160"/>
</p>

<p align="center">
  <strong>以 Java 为核心的 AI 编码代理与工作台</strong><br/>
  面向本地代码库的推理循环、工具调用、会话协作与桌面工作台。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Java-blue?logo=openjdk" alt="Java"/>
  <img src="https://img.shields.io/badge/Solon-important" alt="Solon"/>
  <img src="https://img.shields.io/badge/Vue-4FC08D?logo=vue.js" alt="Vue"/>
  <img src="https://img.shields.io/badge/React-61DAFB?logo=react" alt="React"/>
  <img src="https://img.shields.io/badge/Electron-47848F?logo=electron" alt="Electron"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
</p>

<p align="center">
  <a href="https://loopra.cn">官网</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#配置参考">配置参考</a> ·
  <a href="#从源码开发">从源码开发</a>
</p>

安装包见 [Releases](https://github.com/ezdemo/loopra-release/releases/latest)，变更记录见 [CHANGELOG.md](https://github.com/ezdemo/loopra-release/blob/main/CHANGELOG.md)。

## 技术交流群

想交流 AI 编码代理的玩法、反馈问题或提建议？扫码添加我的个人微信，备注 **loopra**，我会拉你进技术交流群：

<p align="center">
  <img src="img/wx.png" alt="个人微信二维码（添加时请备注 loopra）" width="240"/>
</p>

## 概览

Loopra 将用户任务、模型推理与受控工具调用组织成持续执行循环：它读取项目上下文，搜索、编辑或构建代码，消费执行结果后继续推理，直至完成任务或需要用户决策。

提供 Web 与 Electron Desktop 工作台，适合在本地代码库中完成开发、排障、测试、文档整理和多步骤协作。

Web 与 Electron 主窗口默认使用 React + TypeScript + NextUI 工作台，包含项目与会话、聊天、模型配置、工具与集成、文件预览和 Git 面板。Vue 兼容控制台保留在 `/legacy.html`，安装、更新、宠物等独立辅助窗口仍使用 Vue。源码和开发说明见 [前端说明](loopra-front/README.md) 与 [Web 工作台](loopra-front/web/README.md)。

主聊天的 Native ACP 接入、协议扩展与当前迁移范围见 [Native ACP 接入](docs/acp-native.md)。
外部 Agent 接入见 [Claude Code](docs/acp-claude.md) 和 [Codex](docs/acp-codex.md)。新建会话时可选择引擎；外部引擎需要在后端所在机器安装相应依赖并完成认证，已有消息或远端绑定的会话不能直接切换引擎。下文的内置工具、模型渠道与审批规则主要适用于 Loopra Native，外部引擎的能力取决于各自适配器。

```text
任务 -> 模型推理 -> 工具调用 -> 结果反馈 -> 模型推理 -> ... -> 完成
```

| 面向的工作 | Loopra 提供的能力 |
|---|---|
| 处理代码库任务 | 项目内文件读写、代码检索、命令执行与 API 调用 |
| 保持任务连续性 | JSONL 会话、上下文折叠、Goal、Checklist 与项目记忆 |
| 控制工具执行 | 工具权限分类、按模式启用的 HITL 审批与路径审核、可选的独立校验模型 |
| 使用合适的界面 | Web 管理界面与包含本地进程、文件、Git、浏览器的 Desktop 工作台 |

## 快速开始

桌面端与命令行安装可分别使用。

桌面端下载地址：[Releases](https://github.com/ezdemo/loopra-release/releases/latest)。

Desktop 通过启动页在线安装核心运行时到 `~/.loopra-gui`，配置继续使用 `~/.loopra`；CLI 安装在 `~/.loopra`。桌面端会检查本机 `4567` 端口的服务健康与版本，符合条件时可复用，否则启动自己的核心服务。Java 优先使用系统 Java 17+，也支持已有的捆绑 JRE；缺失时可在依赖管理页下载安装。安装与更新支持 GitHub 直连和镜像源。

### 1. 安装命令行入口

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.sh | bash
```

国内网络可选用 Github 镜像脚本（脚本与安装包仍从 Github 下载，速度更快）：

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-mirror.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-mirror.sh | bash
```

所有安装脚本（`setup.ps1` / `setup.sh` 及其 `-mirror`、`-gui` 变体）都支持通过 `LOOPRA_MIRROR` 环境变量指定具体镜像（镜像列表可在桌面端下载源选择中自动测速排序后挑选）：

Windows PowerShell：

```powershell
$env:LOOPRA_MIRROR='https://gh-proxy.org/'; irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.ps1 | iex
```

macOS / Linux：

```bash
export LOOPRA_MIRROR='https://gh-proxy.org/'; curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.sh | bash
```

未设置 `LOOPRA_MIRROR` 时：直连脚本走 GitHub 官方源，镜像脚本（`-mirror` 变体）默认使用 `gh-proxy.org`。

也可通过 npm 安装（作为 GitHub 直连/镜像之外的备用下载源，分发包可从 npm registry 含 npmmirror 等国内镜像拉取）：

```bash
# 全局安装并自动安装到 ~/.loopra（postinstall 自动执行，等效官方一键安装脚本）
npm install -g loopra-dist

# 不需要自动安装时，跳过 postinstall
npm install -g loopra-dist --ignore-scripts
```

> npm 的生命周期脚本是否执行取决于本机 npm 配置。想看安装进度与镜像测速，可使用 `npm install -g loopra-dist --foreground-scripts`；安装器执行后的日志位于 `~/.loopra/install.log`。未设置 `LOOPRA_MIRROR` 时，postinstall 会测速候选 GitHub 代理镜像并选择可用源，全部失败则回退直连。

> **macOS 用户注意**：未签名或未公证的桌面安装包可能被 Gatekeeper 拦截。确认安装包来自项目 Releases 且下载完整后，可尝试以下方式：
>
> 1. 将 `Loopra.app` 拖入「应用程序」后，在终端执行：
>
> ```bash
> xattr -cr "/Applications/Loopra.app"
> ```
>
> 2. 或右键点击 `Loopra.app` → 选择「打开」→ 在弹窗中点击「打开」。
> 3. 或到「系统设置 → 隐私与安全性」底部点击「仍要打开」。

### 2. 启动服务

使用 `0` 让服务自动选择可用端口：

```bash
loopra web 0
```

控制台会输出本地访问地址。首次启动会在 `~/.loopra/config.json` 创建默认配置。

### 3. 配置模型渠道

使用 Loopra Native 时，在设置页维护模型渠道并保存；直接编辑 `~/.loopra/config.json` 后需重启服务以重新加载。每个渠道独立维护 API 地址、密钥、协议、特殊兼容与模型能力。`apiProtocol` 支持 `chat_completions`、`responses` 和 `anthropic`；`specialCompatibility` 默认为空，可选 `opencode`，由兼容插件携带稳定的 `x-opencode-session` 会话路由头。

```json
{
  "model": "deepseek-v4-flash",
  "modelChannelId": "default",
  "modelChannels": [
    {
      "id": "default",
      "name": "Default",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-your-api-key",
      "apiProtocol": "chat_completions",
      "specialCompatibility": "",
      "models": [
        {
          "name": "deepseek-v4-flash",
          "contextTokens": -1,
          "maxTokens": 32768,
          "imageInput": false
        }
      ]
    }
  ],
  "workspaceDir": "/path/to/your/project"
}
```

`models` 兼容旧版字符串数组。每个模型条目还可配置 `contextTokens`、`maxTokens`、`imageInput` 和 `price`；其中 `maxTokens` 是该模型单次请求的最大输出 token 数，包含推理 token，Chat Completions 映射为 `max_tokens`，Responses 映射为 `max_output_tokens`。未配置时使用默认值 32768。若当前模型的 `imageInput` 为 `false`，可在模型渠道页选择 `imageUnderstandingModel` 与 `imageUnderstandingModelChannelId`，由该模型先把 `read_image` 的图片转换为文字，再交给当前模型继续处理。`read_image` 的 `prompt` 参数用于描述本次识别任务，例如要求提取 OCR、定位报错或读取表格数值。

除全局默认模型外，每个会话可单独选择模型、渠道与推理强度，选择持久化在服务端会话元数据中，重开或切换会话时自动恢复。首页当前选择的 Agent，以及每个 Agent 最近明确选择的模型、权限和推理强度等配置，分别保存到核心服务所在机器的 `~/.loopra/agent-preferences.json`。新会话继承对应 Agent 的上次配置，已有会话保留自己的设置；计划模式不继承，已移除或不再支持的选项会跳过。未保存过 Agent 偏好时使用该引擎的默认配置。

## 核心能力

| 能力 | 说明 |
|---|---|
| 自主推理循环 | 流式输出推理、工具调用和结果，持续处理多轮任务。 |
| 上下文管理 | JSONL 会话持久化、自动摘要折叠、消息自愈和 token 用量统计。 |
| 多模型渠道 | 支持多渠道、Chat Completions API、OpenCode 兼容网关、OpenAI Responses API、Anthropic Messages API、推理强度和模型能力配置。 |
| 可扩展工具系统 | 内核基于 cutin 插件化框架，插件支持热插拔、可在设置页管理运行时，并通过 `/plugin add` 一行命令从 jar 直链或本地路径安装外置插件；工具经 Solon `@ToolMapping` 声明式注册，支持内置工具、MCP、OpenAPI、技能和 REST API。 |
| 拓展包体系 | 基于 Solon H-SPI 的拓展包（ExtPack）机制：安装 jar 即扩展 Agent 工具与拦截能力，设置页可粘贴 jar 地址/本地路径安装，并支持启用/停用与卸载（`~/.loopra/extpacks`）；附 `loopra-extra-demo` 示例工程。 |
| 代码库操作 | 在项目边界内读取、搜索、编辑文件，运行一次性或交互式命令。 |
| 子代理协作 | 默认提供 `explore`、`implement`、`test`、`review`、`plan` 五种角色，支持独立上下文、工具范围和超时控制；可在智能体设置中编辑角色与渠道模型。 |
| 计划模式 | 输入框一键进入只读探索，探索完成后提交计划供用户审查，批准后按计划执行。 |
| 隔离分支 | 后端按会话维护 Agent 的本地/隔离分支执行根；Electron Desktop 的“环境信息”面板展示真实路径、分支和变更，并负责提交、合并与推送。 |
| 需求池 | 以看板管理需求，支持 AI 自动执行、评论与执行日志、立即/定时执行，以及按需求配置模型和审批模式。 |
| 持久协作状态 | Checklist、会话级 Goal、项目记忆和共享上下文支持长任务及父子代理协作。 |
| 审批与边界 | 三态 HITL、只读工具与项目内操作审核；`auto` 模式可追加独立校验模型，无法自动批准时转人工。详见下方模式说明。 |
| 桌面工作台 | React 主工作台通过 Electron 桥接提供文件编辑、原生终端、环境与 Git 操作、进程管理和窗口控制；AI 浏览器、需求池、宠物等使用独立窗口。Web 与 Desktop 的可用功能取决于运行环境。 |
| 纯聊天模式 | 工作区选择中的「纯聊天」不暴露项目、文件、终端或 Git 能力，只启用 `webfetch`、`websearch`、`codesearch` 等联网查询工具；会话仍独立持久化。 |

### 工具与扩展

工具由 Solon 自动发现，可在工具管理界面启用、禁用，并为自定义工具指定只读或写入分类。

| 分类 | 覆盖场景 |
|---|---|
| 文件与代码检索 | `read`、`write`、`edit`、`glob`、`grep`、`ls`、`java_source`、`codesearch` |
| 命令与网络 | `bash`、交互式命令会话、`webfetch`、`websearch`、`call_api` |
| 任务协作 | `sub_agent`、`checklist_*`、`goal_*`、`workspace_*` |
| 项目状态 | `memory` 将跨会话事实保存到 `.loopra/loopra-memory.md`；共享上下文保存到 `.loopra/workspace/` |
| 多模态 | `read_image` 支持模型原生图片输入及图片理解模型 |

MCP、OpenAPI 和技能可为 Agent 注入额外工具。除用户级 `~/.loopra/mcp-servers.json` 外，项目根目录下的 `.loopra/mcp-servers.json` 也会被自动读取；项目级配置只对当前项目的 Agent 生效，不会写入或污染用户级 MCP 配置。项目技能可放在 `.loopra/skills/<skill-name>/SKILL.md`，与用户级 `~/.loopra/skills` 分开挂载。桌面端会话左侧的“项目能力”入口只展示当前项目 Skill、项目 MCP 连接状态及工具列表。修改项目 MCP 文件后，可点击该面板的刷新按钮，或让 Agent 调用 `mcprefresh`；后者会在当前回复结束后重建连接，并从下一条消息起使用新工具。项目文件支持标准的 `mcpServers` 对象格式，也兼容 Loopra 管理页使用的 `servers` 数组格式，例如：

```json
{
  "mcpServers": {
    "project-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["tools/server.js"],
      "env": {"PROJECT_ROOT": "."}
    }
  }
}
```

`read_image` 支持项目路径、绝对路径、Base64/data URI 和 HTTP(S) URL，单张图片最大 5 MiB，并支持可选的 `detail`（`auto`、`low`、`high`）和 `prompt`（本次图片识别任务描述）；当前模型支持 `imageInput` 时原图会作为视觉上下文传入，否则使用已配置的图片理解模型并带上 `prompt` 生成文字结果。

在项目会话中，用户主动上传图片时，如果当前模型不支持 `imageInput`，系统会先将图片保存到当前项目的 `.loopra/read_img/`，再把项目相对路径和 `read_image` 调用提示交给模型；模型需要理解图片时，应使用该路径调用 `read_image`，而不是猜测图片内容。支持图片输入的模型仍直接接收原图。纯聊天不提供本地图片读取工具，上传图片需选择支持 `imageInput` 的模型，否则会提示切换模型。

Loopra 也可以在设置页的「MCP 服务器 → 发布 Loopra 工具」中作为 MCP Server 对外提供工具。发布默认关闭，启用后使用 Streamable HTTP（默认 `/mcp`，也可切换 SSE）；工具选择与子代理 `allowedTools` 语义一致：选择「全部已启用」发布当前启用工具，选择「手动选择」时只发布白名单中的工具。配置保存于 `~/.loopra/mcp-server.json`，全局禁用的工具始终不会被发布。连接地址为当前 Web 服务地址加上配置的 endpoint，例如 `http://127.0.0.1:8080/mcp`。

在同一设置页还可以使用「Cloudflare Tunnel 内网穿透」一键启动 Cloudflare Quick Tunnel。Loopra 由 Java `ProcessBuilder` 管理本机 `cloudflared` 进程，不依赖 cmd、bash 或平台专用脚本，因此 Windows、macOS、Linux 均可使用；首次使用需要先安装 `cloudflared` 并加入 PATH，也可以在页面填写可执行文件路径。Quick Tunnel 会生成临时随机公网地址，应用退出后失效；Java 本地代理只转发已配置的 MCP endpoint，不会把 Loopra 的其它 Web 路由一起暴露。该能力适合开发和测试，Quick Tunnel 不支持 SSE，请将 MCP 传输方式设为 Streamable HTTP。

### 子代理与长期协作

子代理通过 `sub_agent` 派生。默认配置中，`explore`、`review` 和 `plan` 只读项目内容，但可使用共享上下文进行协作通信；`implement` 与 `test` 可按配置执行写操作。每个子代理拥有独立推理上下文，不能继续派生子代理。

项目记忆只保存稳定、可复用的项目事实，例如架构约定、已知限制和用户偏好。复杂任务可使用会话级 Goal 记录步骤、证据、阻塞原因与验证结果；Checklist 用于展示有序执行进度。

### 审批与访问边界

`hitl` 支持三种执行模式：

| 模式 | 行为 |
|---|---|
| `free` | 跳过工具审批审核，包括审核链的项目边界检查；工具自身的参数校验仍生效。 |
| `approval` | 自动放行只读工具、普通项目内文件写入和可识别的项目内命令；其余调用转人工审批。 |
| `auto` | 先应用与 `approval` 相同的规则，再使用已配置的校验模型审核剩余调用；未配置、未批准或审核失败时转人工。 |

`validationModel` 与 `validationModelChannelId` 用于 `auto` 模式的独立 AI 审核。在 `approval` 与 `auto` 模式中，审核链识别到项目外文件写入或命令目标时会先要求人工确认，不能由校验模型放行。`free` 不提供这层审批约束。这是应用层审核，不是操作系统沙箱。

## 配置参考

主要配置文件为 `~/.loopra/config.json`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `modelChannels` | array | 默认渠道 | API 地址、密钥、协议与模型条目。 |
| `modelChannelId` | string | `default` | 当前模型所属渠道 ID。 |
| `model` | string | `deepseek-v4-flash` | 当前模型名称。 |
| `validationModel` | string | `""` | 可选的工具调用校验模型。 |
| `validationModelChannelId` | string | `""` | 校验模型所在渠道 ID。 |
| `imageUnderstandingModel` | string | `""` | 当前模型不支持图片输入时使用的图片理解模型；需在模型条目中启用 `imageInput`。 |
| `imageUnderstandingModelChannelId` | string | `""` | 图片理解模型所在渠道 ID。 |
| `workspaceDir` | string | 自动创建默认项目 | 当前项目目录。 |
| `reasoningEffort` | string | `high` | `low`、`medium`、`high` 或 `max`。 |
| `hitl` | string | `free` | `free`、`approval` 或 `auto`。 |
| `editMode` | string | `auto` | 编辑模式。 |
| `maxContextChars` | int | `200000` | 上下文字符预算。 |
| `keepTailChars` | int | `80000` | 折叠后保留的最近上下文预算。 |
| `toolTimeoutSec` | int | `360` | 单工具超时秒数。 |
| `subAgentTimeoutSec` | int | `3600` | 子代理完整任务超时秒数。 |
| `disabledTools` | string[] | `[]` | 禁用的工具名称。 |
| `blockedPaths` | string[] | `[]` | 受限路径列表。 |
| `worktreeBaseDir` | string | `~/.loopra/worktree` | 隔离分支模式的根目录（可用系统属性 `loopra.worktree.baseDir` 覆盖，供测试/嵌入方使用）。 |

首次启动未指定 `workspaceDir` 时，Loopra 会在配置目录旁创建默认项目，避免将启动目录意外作为项目根目录。

## 使用方式

### Web 与 Desktop

`loopra web [port]` 启动 Web 服务，控制台会输出本地访问地址。Web 界面支持会话、项目、工具、模型渠道、文件预览、Git、配置与需求管理；Electron Desktop 增加原生终端、文件编辑、进程管理、AI 浏览器及独立辅助窗口。文件、命令与系统目录操作发生在后端所在机器。

### 聊天命令

Loopra Native 的常用命令与入口如下；完整列表以界面命令菜单和 `/help` 为准。外部 ACP Agent 的命令由各自引擎提供。

| 命令 | 用途 |
|---|---|
| `/help` | 显示可用命令。 |
| 侧栏新建与会话列表 | 创建、打开与管理项目会话。 |
| 计划模式按钮 | 输入框左侧按钮进入只读计划模式，探索完成后提交计划供审查，批准后自动按计划执行。 |
| `/compact` | 手动折叠历史上下文。 |
| `/goal ...` | 创建、查看、暂停、恢复、阻塞或完成会话目标。 |
| `/hitl` / `/agree` / `/deny` | 切换审批模式或处理待审批工具调用。 |
| `/continue` | 继续当前任务。 |
| `/plugin ...` | 管理运行时插件。 |
| `/init` | 分析项目并生成项目文档。 |

### 输入框辅助功能

输入框底部的“常用要求”用于管理个人预设，数据保存到 `~/.loopra/prompt-presets.json`；点击预设会直接追加到当前输入框，首次使用时列表默认为空。生成期间发送的新消息会排队显示，可移除，也可以引导发送以停止当前生成并立即处理排队消息。重新打开或切换到仍在后台执行的会话时，输入区会保持锁定并提供停止入口，直到任务结束。
### ACP

Loopra 可以作为 ACP Agent 供外部客户端连接：

```bash
# stdio 模式（仅启动 ACP，不启动 HTTP 服务）
loopra acp

# WebSocket 模式
loopra acp 8765
```

## 从源码开发

### 前置条件

- JDK 17+
- Maven 3.9+
- Node.js `^20.19.0` 或 `>=22.12.0`（以 `loopra-front/package.json` 的 `engines` 为准）
- pnpm 8+

### 构建与测试

```bash
# 构建后端模块
mvn clean package

# 运行全部后端测试
mvn test

# 仅验证 Loopra 模块及其依赖模块
mvn -pl loopra -am test
```

后端依赖方向、聊天任务生命周期与验证约定见 [后端架构说明](docs/backend-architecture.md)。

### 前端与 Desktop

```bash
cd loopra-front
pnpm install

# 启动前端开发服务
pnpm dev

# 验证 React 工作台
pnpm test:web

# 运行 Vue 测试并构建全部前端入口
pnpm test -- --run
pnpm build

# 启动 Electron 开发模式
pnpm dev:electron
```

前端开发地址为 `http://127.0.0.1:3000/`，`/api` 默认代理到本机 `4567` 端口；单独开发前端时，先运行 `loopra web 4567`，或在设置中指定实际服务地址。`pnpm build` 输出到 `loopra-front/dist/renderer`；同步到 Java 静态资源及桌面打包由发版仓库脚本完成，单独执行 Maven 不会构建 React/Vue 源码。

## 项目结构

```text
loopra/
├── cutin/           # Cutin 核心框架：插件化生命周期、ModelProvider、工具注册表、循环引擎
├── loopra/          # 基于 cutin 的单模块 Loopra：Agent 内核、内置工具、ACP、Solon Web、发布打包
├── loopra-front/    # React 主工作台、Vue 兼容/辅助页面与 Electron Desktop
├── loopra-extra-demo/ # 拓展包示例（不在根 Maven 聚合模块中）
├── intro/           # 官网内容
├── docs/            # 项目文档
├── .workflow/       # 后端检查脚本与 Maven 配置
└── .github/         # GitHub Actions 源码测试
```

安装与发版工作流位于 [loopra-release](https://github.com/ezdemo/loopra-release)，发布配置与操作以该仓库为准。应用版本由自动发布流程写入构建所需文件，README 不维护固定发布版本。

### 模块依赖关系

```text
loopra      →  cutin
```

`cutin` 是插件化核心框架，`loopra` 是基于它组装出来的完整 Loopra 应用：

- 需要通用 Agent 编排、生命周期拦截、工具注册和模型 Provider 能力 → 依赖 `cutin`
- 需要开箱即用的 LoopraAgent、内置工具、ACP、Web 服务与桌面端 → 依赖 `loopra`

## 技术栈

| 层 | 技术 |
|---|---|
| 核心 | Java、Cutin、Solon、Snack4、OkHttp |
| Web | Solon Web、Jetty、SSE、Knife4j |
| 主工作台 | React、TypeScript、NextUI、Vite |
| 兼容与辅助页面 | Vue、Pinia、Ant Design Vue |
| 桌面 | Electron、electron-builder |
| 协议 | MCP、OpenAPI、ACP、Chat Completions API、OpenCode 兼容网关、Responses API、Anthropic Messages API |
| 持久化 | JSONL 会话、项目本地 JSON、项目 Markdown 记忆 |

## 许可证

[MIT License](LICENSE) © 2026 Sorghum

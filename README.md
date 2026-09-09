<h1 align="center">Loopra</h1>

<p align="center">
  <img src="img/logo.png" alt="Loopra logo" width="160"/>
</p>

<p align="center">
  <strong>纯 Java 的 AI 编码代理</strong><br/>
  面向本地代码库的推理循环、工具调用、会话协作与桌面工作台。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Java-17-blue?logo=openjdk" alt="Java 17"/>
  <img src="https://img.shields.io/badge/Solon-4.0.6-important?logo=java" alt="Solon 4.0.6"/>
  <img src="https://img.shields.io/badge/Vue-3.4-4FC08D?logo=vue.js" alt="Vue 3"/>
  <img src="https://img.shields.io/badge/Electron-42.4-47848F?logo=electron" alt="Electron"/>
  <img src="https://img.shields.io/badge/version-26.9.91-lightgrey" alt="Version 26.9.91"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
</p>

<p align="center">
  <a href="https://loopra.cn">官网</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#配置参考">配置参考</a> ·
  <a href="#从源码开发">从源码开发</a>
</p>

> 当前版本：`26.9.91`。完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 技术交流群

想交流 AI 编码代理的玩法、反馈问题或提建议？扫码添加我的个人微信，备注 **loopra**，我会拉你进技术交流群：

<p align="center">
  <img src="img/wx.png" alt="个人微信二维码（添加时请备注 loopra）" width="240"/>
</p>

## 概览

Loopra 将用户任务、模型推理与受控工具调用组织成持续执行循环：它读取项目上下文，搜索、编辑或构建代码，消费执行结果后继续推理，直至完成任务或需要用户决策。

提供 Web 与 Electron Desktop 工作台，适合在本地代码库中完成开发、排障、测试、文档整理和多步骤协作。

```text
任务 -> 模型推理 -> 工具调用 -> 结果反馈 -> 模型推理 -> ... -> 完成
```

| 面向的工作 | Loopra 提供的能力 |
|---|---|
| 处理代码库任务 | 项目内文件读写、代码检索、命令执行与 API 调用 |
| 保持任务连续性 | JSONL 会话、上下文折叠、Goal、Checklist 与项目记忆 |
| 安全地协作 | 工具权限分类、HITL 审批、路径边界与独立校验模型 |
| 使用合适的界面 | Web 管理界面与包含本地进程、文件、Git、浏览器的 Desktop 工作台 |

## 快速开始

> 建议手动运行下面命令再安装桌面端

桌面端下载地址：[Releases](https://github.com/ezdemo/loopra/releases/latest)。

Desktop 首次启动会安装独立运行时到 `~/.loopra-gui`；CLI 仍安装在 `~/.loopra`，两者共用配置目录但不会复用或终止对方的服务进程。Desktop 启动时优先复用本机 `4567` 端口上的健康 Loopra Web 服务，并展示启动窗口（核心服务与依赖管理）；安装包内置核心运行时（`resources/loopra-core`），首次安装优先使用内置包本地安装（无网络也可完成；Java 优先复用系统 Java 17+ 或已有捆绑 JRE，缺失时安装脚本自动下载 JRE 25，也可在启动窗口中选择镜像安装/重装 JRE 25），内置包缺失或本地安装失败时自动回退到在线下载源（GitHub 直连或镜像加速）。下载源支持 GitHub 直连与镜像列表（自动测速并按延迟排序、可一键重测，选中的镜像同时用于 JRE 下载与更新脚本）；更新入口复用启动窗口，可直接更新核心服务与桌面端，也可以暂不更新继续使用。

### 1. 安装

Windows PowerShell：

```powershell
irm https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/setup.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/setup.sh | bash
```

国内网络可选用 Github 镜像脚本（脚本与安装包仍从 Github 下载，速度更快）：

Windows PowerShell：

```powershell
irm https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/setup-mirror.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/setup-mirror.sh | bash
```

所有安装脚本（`setup.ps1` / `setup.sh` 及其 `-mirror`、`-gui` 变体）都支持通过 `LOOPRA_MIRROR` 环境变量指定具体镜像（镜像列表可在桌面端下载源选择中自动测速排序后挑选）：

Windows PowerShell：

```powershell
$env:LOOPRA_MIRROR='https://gh-proxy.org/'; irm https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/setup.ps1 | iex
```

macOS / Linux：

```bash
export LOOPRA_MIRROR='https://gh-proxy.org/'; curl -fsSL https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/setup.sh | bash
```

未设置 `LOOPRA_MIRROR` 时：直连脚本走 GitHub 官方源，镜像脚本（`-mirror` 变体）默认使用 `gh-proxy.org`。

也可通过 npm 安装（作为 GitHub 直连/镜像之外的备用下载源，分发包可从 npm registry 含 npmmirror 等国内镜像拉取）：

```bash
# 全局安装并自动安装到 ~/.loopra（postinstall 自动执行，等效官方一键安装脚本）
npm install -g loopra-dist

# 不需要自动安装时，跳过 postinstall
npm install --ignore-scripts
```

> npm 出于安全默认隐藏生命周期脚本输出（安装会正常跑完）；想看实时进度与镜像测速，用 `npm install -g loopra-dist --foreground-scripts`，或查看 `~/.loopra/install.log`。未设置 `LOOPRA_MIRROR` 时，postinstall 会自动测速各候选 GitHub 代理镜像并选用最快者（全部失败则回退直连）。

> **macOS 用户注意**：桌面端（Releases 中的 `Loopra-*.zip`）目前未做 Apple 签名与公证，首次打开可能提示 **“Loopra”已损坏，无法打开**。这是 macOS Gatekeeper 对未签名应用的拦截，安装包本身没有损坏，按下面任一种方式放行即可：
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

在 Web 设置页维护模型渠道，或直接编辑 `~/.loopra/config.json`。配置 API Key 后重启服务。每个渠道独立维护 API 地址、基础接口类型、特殊兼容与模型能力；`apiProtocol` 只支持 `chat_completions`、`responses` 和 `anthropic`，`specialCompatibility` 默认为空，目前可选 `opencode`。启用后由 OpenCode 兼容插件自动携带稳定的 `x-opencode-session` 会话路由头，适用于 OpenCode Zen/Go 兼容网关。首次使用且尚未配置模型渠道时，界面会显示引导提示，帮助完成 API 地址、密钥和模型配置。

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

除全局默认模型外，每个会话可单独选择模型、渠道与推理强度（聊天页会话栏的模型选择器），选择持久化在服务端会话元数据中，重开或切换会话时自动恢复；未选择过时使用全局默认值。

## 核心能力

| 能力 | 说明 |
|---|---|
| 自主推理循环 | 流式输出推理、工具调用和结果，持续处理多轮任务。 |
| 上下文管理 | JSONL 会话持久化、自动摘要折叠、消息自愈和 token 用量统计。 |
| 多模型渠道 | 支持多渠道、Chat Completions API、OpenCode 兼容网关、OpenAI Responses API、Anthropic Messages API、推理强度和模型能力配置。 |
| 可扩展工具系统 | 内核基于 cutin 插件化框架，插件支持热插拔、可在设置页管理运行时，并通过 `/plugin add` 一行命令从 jar 直链或本地路径安装外置插件；工具经 Solon `@ToolMapping` 声明式注册，支持内置工具、MCP、OpenAPI、技能和 REST API。 |
| 拓展包体系 | 基于 Solon H-SPI 的拓展包（ExtPack）机制：安装 jar 即扩展 Agent 工具与拦截能力，设置页可粘贴 jar 地址/本地路径安装，并支持启用/停用与卸载（`~/.loopra/extpacks`）；附 `loopra-extra-demo` 示例工程。 |
| 代码库操作 | 在项目边界内读取、搜索、编辑文件，运行一次性或交互式命令。 |
| 子代理协作 | 内置 `explore`、`implement`、`test`、`review`、`plan` 五种角色，支持隔离上下文、权限约束和超时控制；配置可在桌面端编辑并持久化，支持选择渠道模型。 |
| 计划模式 | 输入框一键进入只读探索，探索完成后提交计划供用户审查，批准后按计划执行。 |
| 隔离分支 | 后端按会话维护 Agent 的本地/隔离分支执行根；Electron Desktop 的“环境信息”面板展示真实路径、分支和变更，并负责提交、合并与推送。 |
| 需求池 | 以看板管理需求，支持 AI 自动执行、评论与执行日志、立即/定时执行，以及按需求配置模型和审批模式。 |
| 持久协作状态 | Checklist、会话级 Goal、项目记忆和共享上下文支持长任务及父子代理协作。 |
| 审批与边界 | 三态 HITL、工具白名单、路径边界保护，以及可选的独立校验模型。 |
| 桌面工作台 | Electron Desktop 提供多聊天标签、文件资源管理器（实时监听磁盘变化）、Monaco 文件编辑器（含 Git 脏文件差异对比）、终端面板（node-pty，支持垂直/水平模式）、环境信息与 Git 操作面板、活动栏、元素检查、服务进程管理、AI 浏览器、需求池窗口、子代理会话面板（回放与续聊）与全局聊天搜索；会话/首页浮层菜单与原生标题栏、左侧边栏可拖拽调整宽度。 |

### 工具与扩展

工具由 Solon 自动发现，可在工具管理界面启用、禁用，并为自定义工具指定只读或写入分类。

| 分类 | 覆盖场景 |
|---|---|
| 文件与代码检索 | `read`、`write`、`edit`、`glob`、`grep`、`ls`、`java_source`、`codesearch` |
| 命令与网络 | `bash`、交互式命令会话、`webfetch`、`call_api` |
| 任务协作 | `sub_agent`、`checklist_*`、`goal_*`、`workspace_*` |
| 项目状态 | `memory` 将跨会话事实保存到 `.loopra/loopra-memory.md`；共享上下文保存到 `.loopra/workspace/` |
| 多模态与浏览器 | `read_image`，以及桌面端可见 AI 浏览器的 `browser_*` 工具 |

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

`read_image` 支持项目路径、绝对路径、Base64/data URI 和 HTTP(S) URL，单张图片最大 5 MiB，并支持可选的 `detail`（`auto`、`low`、`high`）和 `prompt`（本次图片识别任务描述）；当前模型支持 `imageInput` 时原图会作为视觉上下文传入，否则使用已配置的图片理解模型并带上 `prompt` 生成文字结果。`browser_screenshot` 会返回可见视口截图和结构化页面快照，交互操作必须使用对应的 `snapshotId`。浏览器工具只操作可见的 Desktop 浏览器；遇到登录、验证码或安全验证时，Agent 会请求用户接管，不会代填或读取敏感凭据。

用户主动上传图片时，如果当前模型不支持 `imageInput`，系统会先将图片保存到当前项目的 `.loopra/read_img/`，再把项目相对路径和 `read_image` 调用提示交给模型；模型需要理解图片时，应使用该路径调用 `read_image`，而不是猜测图片内容。支持图片输入的模型仍直接接收原图。

Loopra 也可以在设置页的「MCP 服务器 → 发布 Loopra 工具」中作为 MCP Server 对外提供工具。发布默认关闭，启用后使用 Streamable HTTP（默认 `/mcp`，也可切换 SSE）；工具选择与子代理 `allowedTools` 语义一致：选择「全部已启用」发布当前启用工具，选择「手动选择」时只发布白名单中的工具。配置保存于 `~/.loopra/mcp-server.json`，全局禁用的工具始终不会被发布。连接地址为当前 Web 服务地址加上配置的 endpoint，例如 `http://127.0.0.1:8080/mcp`。

在同一设置页还可以使用「Cloudflare Tunnel 内网穿透」一键启动 Cloudflare Quick Tunnel。Loopra 由 Java `ProcessBuilder` 管理本机 `cloudflared` 进程，不依赖 cmd、bash 或平台专用脚本，因此 Windows、macOS、Linux 均可使用；首次使用需要先安装 `cloudflared` 并加入 PATH，也可以在页面填写可执行文件路径。Quick Tunnel 会生成临时随机公网地址，应用退出后失效；Java 本地代理只转发已配置的 MCP endpoint，不会把 Loopra 的其它 Web 路由一起暴露。该能力适合开发和测试，Quick Tunnel 不支持 SSE，请将 MCP 传输方式设为 Streamable HTTP。

### 子代理与长期协作

子代理通过 `sub_agent` 派生。`explore`、`review` 和 `plan` 为只读角色；`implement` 与 `test` 可执行经过授权的写操作。每个子代理拥有独立推理上下文，并可经由共享上下文传递结构化结果。

项目记忆只保存稳定、可复用的项目事实，例如架构约定、已知限制和用户偏好。复杂任务可使用会话级 Goal 记录步骤、证据、阻塞原因与验证结果；Checklist 用于展示有序执行进度。

### 审批与访问边界

`hitl` 支持三种执行模式：

| 模式 | 行为 |
|---|---|
| `free` | 所有工具直接执行。 |
| `approval` | 非只读工具执行前等待用户批准。 |
| `auto` | 白名单工具自动放行，其余调用等待批准。 |

可配置 `validationModel` 与 `validationModelChannelId`，让独立模型在人工审批前评估高风险工具调用。无论当前模式或校验结果如何，访问项目边界外的路径仍需要人工确认。

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

`loopra web [port]` 启动 Web 服务，控制台会输出本地访问地址。Web 界面支持会话、项目、工具、模型渠道、Git 和配置管理，并提供需求池 API；Electron Desktop 在此基础上增加本地进程、文件资源管理器与文件编辑器、终端、浏览器、需求池窗口和桌面上下文菜单能力。

### 聊天命令

在聊天输入框中使用以下命令：

| 命令 | 用途 |
|---|---|
| `/help` | 显示可用命令。 |
| `/new` | 创建会话。 |
| `/sessions` / `/load N` | 查看和加载历史会话。 |
| 计划模式按钮 | 输入框左侧按钮进入只读计划模式，探索完成后提交计划供审查，批准后自动按计划执行。 |
| `/compact` | 手动折叠历史上下文。 |
| `/goal ...` | 创建、查看、暂停、恢复、阻塞或完成会话目标。 |
| `/hitl` / `/agree` / `/deny` | 切换审批模式或处理待审批工具调用。 |
| `/retry` / `/rewind N` / `/continue` | 管理当前回复的重试、回退和继续。 |
| `/init` | 分析项目并生成项目文档。 |

### 输入框辅助功能

输入框底部的“常用要求”用于管理个人预设，数据保存到 `~/.loopra/prompt-presets.json`；点击预设会直接追加到当前输入框，首次使用时列表默认为空。生成期间发送的新消息会排队显示，可移除，也可以引导发送以停止当前生成并立即处理排队消息。重新打开或切换到仍在后台执行的会话时，输入区会保持锁定并提供停止入口，直到任务结束。
### ACP

Web 进程可通过启动参数启用 Agent Client Protocol：

```bash
# stdio 模式
loopra web 0 --loopra.acp=true

# WebSocket 模式
loopra web 0 --loopra.acp=true --loopra.acp.ws.port=8765
```

## 从源码开发

### 前置条件

- JDK 17
- Maven 3.9+
- Node.js 18+
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

### 前端与 Desktop

```bash
cd loopra-front
pnpm install

# 启动前端开发服务
pnpm dev

# 运行前端测试并构建
pnpm test -- --run
pnpm build

# 启动 Electron 开发模式
pnpm dev:electron
```

## 项目结构

```text
loopra/
├── cutin/           # Cutin 核心框架：插件化生命周期、ModelProvider、工具注册表、循环引擎
├── loopra/          # 基于 cutin 的单模块 Loopra：Agent 内核、内置工具、ACP、Solon Web、发布打包
├── loopra-front/    # Vue 前端与 Electron Desktop
├── intro/           # 官网内容
├── docs/            # 项目文档
├── .release/        # 安装与发布脚本
├── .workflow/       # 旧版 CI 流水线配置（已迁移至 GitHub Actions）
└── .github/         # GitHub Actions 构建与发布流水线
```

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
| 核心 | Java 17、Solon 4.0.6、Snack4、OkHttp |
| Web | Solon Web、Jetty、SSE、Knife4j |
| 前端 | Vue 3、Vite、Pinia、Ant Design Vue |
| 桌面 | Electron、electron-builder |
| 协议 | MCP、OpenAPI、ACP、Chat Completions API、OpenCode 兼容网关、Responses API、Anthropic Messages API |
| 持久化 | JSONL 会话、项目本地 JSON、项目 Markdown 记忆 |

## 许可证

[MIT License](LICENSE) © 2026 Sorghum

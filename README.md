<h1 align="center">LoopraX</h1>

<p align="center">
  <img src="web/public/loopra-logo.svg" alt="LoopraX logo" width="160"/>
</p>

<p align="center">
  <strong>以 Go 为核心的 AI 编码代理与工作台</strong><br/>
  面向本地代码库的推理循环、工具调用、会话协作与桌面工作台。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white" alt="Go"/>
  <img src="https://img.shields.io/badge/GoFrame-important" alt="GoFrame"/>
  <img src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" alt="React"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
</p>

<p align="center">
  <a href="https://loopra.cn">官网</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#配置参考">配置参考</a> ·
  <a href="#从源码开发">从源码开发</a>
</p>

LoopraX 是 [Loopra](https://github.com/ezdemo/loopra) 的 Go 实现。它读写同一套 `~/.loopra` 配置与 JSONL 会话，工作台、模型渠道、审批和外部 Agent 沿用同一套使用方式。Java 插件与拓展包仍由可选的 Java 兼容后端执行。

## 概览

LoopraX 将用户任务、模型推理与受控工具调用组织成持续执行循环：它读取项目上下文，搜索、编辑或构建代码，消费执行结果后继续推理，直至完成任务或需要用户决策。

提供 Web 与桌面工作台，适合在本地代码库中完成开发、排障、测试、文档整理和多步骤协作。主工作台使用 React、TypeScript 与 NextUI，包含项目与会话、聊天、模型配置、工具与集成、文件预览和 Git 面板。桌面端用同一套页面打开原生窗口。

外部 Agent 接入 Claude Code、Codex、Pi 与 DeepSeek Harness。新建会话时可选择引擎；外部引擎需要在后端所在机器安装相应依赖并完成认证。下文的内置工具、模型渠道与审批规则适用于 Loopra Native，外部引擎的能力取决于各自适配器。

```text
任务 -> 模型推理 -> 工具调用 -> 结果反馈 -> 模型推理 -> ... -> 完成
```

| 面向的工作 | LoopraX 提供的能力 |
|---|---|
| 处理代码库任务 | 项目内文件读写、`rg` 检索、命令执行与联网查询 |
| 保持任务连续性 | JSONL 会话、上下文折叠、会话级模型选择与项目记忆文件 |
| 控制工具执行 | 工具权限分类、按模式启用的 HITL 审批，以及可选的独立校验模型 |
| 使用合适的界面 | Web 工作台，以及打开同一页面的桌面窗口 |

## 快速开始

安装包见 [Releases](https://github.com/ezdemo/loopra-release/releases/latest)。命令行与桌面端可以分别安装。

### 1. 安装

命令行安装后，启动命令是 `loopra`。

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

桌面端：

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui.sh | bash
```

桌面端镜像：

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui-mirror.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui-mirror.sh | bash
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

`LOOPRA_VERSION=v26.10.2901` 可安装指定版本，不设置时安装最新正式版。命令行装到 `~/.looprax/bin`（Windows 为 `%LOCALAPPDATA%\LoopraX\bin`）。macOS 桌面端解压到 `~/Applications/LoopraX.app`。

### 2. 启动

```bash
loopra
loopra web
loopra web 0
loopra web 4567
loopra acp
```

`loopra` 与 `loopra web` 相同。不写端口或写成 `0` 时，由系统分配空闲端口。`loopra acp` 在标准输入输出上提供 ACP，不启动网页。

控制台会输出本地访问地址和本次启动的访问密钥。首次启动会在 `~/.loopra/config.json` 创建默认配置；目录里已有 Loopra 配置时直接沿用。`LOOPRA_HOME` 可改到其他数据目录。

### 3. 从源码运行

需要 Go 1.27.3（以 `go.mod` 为准）、Node.js `^20.19.0` 或 `>=22.12.0`，以及 pnpm 8+。

```bash
git clone https://github.com/ezdemo/looprax.git
cd looprax
cd web && pnpm install && pnpm build && cd ..
go run ./cmd/looprax
```

使用 `0` 或不写端口时，服务自动选择可用端口。需要固定端口时再写，例如 `go run ./cmd/looprax 4567`。桌面窗口与 API 使用同一地址：

```bash
go run ./cmd/looprax-desktop
```

### 4. 配置模型渠道

使用 Loopra Native 时，在设置页维护模型渠道并保存。直接编辑 `~/.loopra/config.json` 后需重启服务以重新加载。每个渠道独立维护 API 地址、密钥、协议、特殊兼容与模型能力。`apiProtocol` 支持 `chat_completions`、`responses` 和 `anthropic`；`specialCompatibility` 默认为空，可选 `opencode`，由兼容逻辑携带稳定的 `x-opencode-session` 会话路由头。

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

`models` 兼容旧版字符串数组。每个模型条目还可配置 `displayName`、`contextTokens`、`maxTokens`、`imageInput` 和 `price`。`maxTokens` 是该模型单次请求的最大输出 token 数，包含推理 token；Chat Completions 映射为 `max_tokens`，Responses 映射为 `max_output_tokens`。未配置或小于等于 `0` 时使用 32768。`contextTokens` 为 `-1` 表示上下文窗口未知。

除全局默认模型外，每个会话可单独选择模型、渠道与推理强度，选择保存在服务端会话元数据中，重开或切换会话时自动恢复。首页当前选择的 Agent，以及每个 Agent 最近明确选择的模型、权限和推理强度，分别保存到 `~/.loopra/agent-preferences.json`。新会话继承对应 Agent 的上次配置，已有会话保留自己的设置；计划模式不继承。

## 核心能力

| 能力 | 说明 |
|---|---|
| 自主推理循环 | 流式输出推理、工具调用和结果，持续处理多轮任务。 |
| 上下文管理 | JSONL 会话持久化、自动摘要折叠、消息整理和 token 用量统计。 |
| 多模型渠道 | 支持多渠道、Chat Completions、OpenCode 兼容网关、OpenAI Responses、Anthropic Messages、推理强度和模型能力配置。 |
| 可扩展工具 | 内置文件、检索、命令与联网工具；MCP 与 OpenAPI 来源、技能市场按项目接入。 |
| 代码库操作 | 在项目边界内读取、搜索、编辑文件，运行一次性或交互式命令。 |
| 子代理协作 | 默认提供 `explore`、`implement`、`test`、`review`、`plan` 五种角色，支持独立上下文、工具范围和超时控制。 |
| 计划模式 | 输入框进入只读探索，探索完成后用 `submit_plan` 提交计划，批准后按计划执行。 |
| 隔离分支 | 会话可切换工作树执行根；Git 面板展示分支、差异，并负责提交与环境信息。 |
| 需求与定时任务 | 以看板管理需求，支持评论、执行记录和定时调度，并可按需求配置模型与审批模式。 |
| 审批与边界 | 三态 HITL；`auto` 模式可追加独立校验模型，无法自动批准时转人工。详见下方模式说明。 |
| 桌面工作台 | `looprax-desktop` 用原生窗口打开同一套 React 工作台。文件、命令与 Git 操作发生在后端所在机器。 |
| 纯聊天 | 工作区中的「纯聊天」只启用 `web` 联网查询，不暴露项目文件、终端或 Git；会话仍独立持久化。 |

### 工具与扩展

工具可在工具管理界面启用、禁用，并为自定义工具指定只读或写入分类。项目内检索统一走内置 `rg`，二进制按目标平台随程序提供，无需另行安装 ripgrep。参数、示例与更新方式见 [rg 工具说明](docs/RG_TOOL.md)。

| 分类 | 覆盖场景 |
|---|---|
| 文件与代码检索 | `read`、`write`、`edit`、`rg` |
| 命令与网络 | 当前系统 shell（Windows 为 `powershell` 或 `CMD`，其他系统为 `bash` 或 `sh`）及其 `_start` / `_wait` / `_stdin` / `_stop`；`web` 的 `search`、`code`、`fetch` |
| 任务协作 | `sub_agent`、`submit_plan`、`ask_choice`；需求会话另有 `finish_requirement`、`reply_requirement_comment`、`show_requirements` |
| 技能 | `skillread`、`skilllist`、`skillsearch`、`skillrefresh` |
| 外部工具 | `tool_search`、`call_tool` 发现并调用 MCP 工具 |

`rg` 用 `content` 搜索内容，用 `files` 枚举路径，用 `files_with_matches` 按内容筛选文件。查看目录结构时使用当前系统 shell。大批量统计优先用 `rg`，避免用 shell 递归枚举后再逐文件扫描。

命令工具支持 `cwd`、`max_char` 和 `timeout`。一次性命令默认最多返回 64000 个字符、超时 120 秒。交互会话先调用 `_start`，再用 `_wait`、`_stdin` 和 `_stop` 管理同一进程。

`web` 用一个入口完成联网：`action=search` 做网页搜索，`action=code` 检索库、SDK 和 API 文档，`action=fetch` 读取 URL 并转成 Markdown、纯文本或 HTML。

LoopraX 随程序提供只读的内置 `SelfSkill`（`@builtin-skills/self-skill`），介绍能力入口、技能发现与加载、MCP / OpenAPI 接入和能力缺失排查。系统提示会引导 Agent 在首次处理任务前通过 `skillread` 读取。

技能还从这些目录挂载，同名技能用完整标识区分：

| 来源 | 位置 | 标识 |
|---|---|---|
| 内置 | 程序内嵌，只读 | `@builtin-skills/self-skill` |
| 用户 | `~/.loopra/skills/<skill-name>/SKILL.md` | `@loopra-skills/...` |
| 通用 | `~/.agents/skills/<skill-name>/SKILL.md` | `@agents-skills/...` |
| 项目 | `<项目>/.loopra/skills/<skill-name>/SKILL.md` | `@project-skills/...` |

目录可在启动后创建，调用 `skillrefresh` 即可发现。通用技能目录可用 `LOOPRA_AGENTS_SKILLS_DIR` 覆盖。技能市场安装到 `~/.loopra/skills`。

MCP 与 OpenAPI 可为 Agent 注入额外能力。用户级配置在 `~/.loopra/mcp-servers.json`，项目级配置在 `<项目>/.loopra/mcp-servers.json`，只对当前项目生效。两种文件都支持标准的 `mcpServers` 对象，也兼容管理页使用的 `servers` 数组：

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

原生 Agent 通过固定的 `tool_search` 和 `call_tool` 使用 MCP。工具定义按需出现在搜索结果里，请求里的工具列表保持稳定。连接在实际检索或调用时建立，当前轮次内复用，轮次结束后关闭。检索方式见 [工具发现与动态调用](docs/TOOL_DISCOVERY.md)。

LoopraX 也可以在设置页「MCP 服务器 → 发布 Loopra 工具」中作为 MCP Server 对外提供工具。发布默认关闭，启用后使用 Streamable HTTP（默认 `/mcp`，也可切换 SSE）。选择「全部已启用」发布当前启用工具，选择「手动选择」时只发布白名单中的工具。配置保存在 `~/.loopra/mcp-server.json`。连接地址为当前 Web 服务地址加上 endpoint，例如 `http://127.0.0.1:8080/mcp`，请求需要 `X-Loopra-Key`。

同一设置页可以一键启动 Cloudflare Quick Tunnel。本机需要已安装 `cloudflared` 并加入 PATH，也可以在页面填写可执行文件路径。Quick Tunnel 生成临时公网地址，应用退出后失效；本地代理只转发已配置的 MCP endpoint。该能力适合开发和测试，Quick Tunnel 不支持 SSE，请将 MCP 传输方式设为 Streamable HTTP。

### 子代理与长期协作

子代理通过 `sub_agent` 派生。默认配置中，`explore`、`review` 和 `plan` 只读；`implement` 与 `test` 可按配置执行写操作。角色定义在 `~/.loopra/sub-agents.json`，可在智能体设置中调整启用状态、说明、工具范围和渠道模型。内置角色的正文在启动时还原，启用状态会保留。

每个子代理拥有独立推理上下文，事件写入父会话的 `.sub/<subSessionId>.jsonl`，并转发到父聊天流。子代理不能再派生子代理，也不能改写 Goal、Checklist 或计划。单次任务超时由 `subAgentTimeoutSec` 控制，默认 3600 秒。

会话 Goal 与 Checklist 保存在数据目录和项目的 `.loopra` 下，供界面展示长任务进度。项目说明可放在数据目录或项目根的 `loopra.md`，以及项目根的 `AGENTS.md`，启动会话时会并入系统提示。

### 审批与访问边界

`hitl` 支持三种执行模式：

| 模式 | 行为 |
|---|---|
| `free` | 跳过工具审批链。工具自身的路径与参数校验仍然生效。 |
| `approval` | 自动放行只读工具、项目内文件写入和可识别的项目内命令；其余调用转人工审批。 |
| `auto` | 先应用与 `approval` 相同的规则，再使用已配置的校验模型审核剩余调用；未配置、未批准或审核失败时转人工。 |

`validationModel` 与 `validationModelChannelId` 用于 `auto` 模式的独立审核。`blockedPaths` 中的路径一律转人工。这是应用层审核，不是操作系统沙箱。旧配置里的布尔值会迁移：`true` 视为 `approval`，`false` 视为 `free`。

## 配置参考

业务配置在 `~/.loopra/config.json`。无法识别的字段会原样保留，以便和 Java 版 Loopra 来回使用。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `modelChannels` | array | 默认渠道 | API 地址、密钥、协议与模型条目。 |
| `modelChannelId` | string | `default` | 当前模型所属渠道 ID。 |
| `model` | string | `deepseek-v4-flash` | 当前模型名称。 |
| `validationModel` | string | `""` | 可选的工具调用校验模型。 |
| `validationModelChannelId` | string | `""` | 校验模型所在渠道 ID。 |
| `imageUnderstandingModel` | string | `""` | 图片理解模型，需在模型条目中启用 `imageInput`。 |
| `imageUnderstandingModelChannelId` | string | `""` | 图片理解模型所在渠道 ID。 |
| `toolModel` | string | `""` | 可选的会话标题模型。 |
| `toolModelChannelId` | string | `""` | 标题模型所在渠道 ID。 |
| `workspaceDir` | string | 自动创建默认项目 | 当前项目目录。 |
| `reasoningEffort` | string | `high` | `none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。 |
| `hitl` | string | `free` | `free`、`approval` 或 `auto`。 |
| `editMode` | string | `auto` | 编辑模式。 |
| `lang` | string | `ZH` | 界面语言，`ZH` 或 `EN`。 |
| `fastMode` | bool | `false` | 快速模式。 |
| `maxContextChars` | int | `200000` | 上下文字符预算。 |
| `keepTailChars` | int | `80000` | 折叠后保留的最近上下文预算。 |
| `toolTimeoutSec` | int | `360` | 单工具超时秒数。 |
| `subAgentTimeoutSec` | int | `3600` | 子代理完整任务超时秒数。 |
| `disabledTools` | string[] | `[]` | 禁用的工具名称。 |
| `blockedPaths` | string[] | `[]` | 受限路径列表。 |
| `worktreeBaseDir` | string | `~/.loopra/worktree` | 隔离分支模式的根目录。 |

首次启动未指定 `workspaceDir` 时，会在数据目录旁创建 `defaultWorkSpace`，避免把启动目录意外当成项目根目录。

进程如何监听、把页面放在哪里，由另一层设置决定，优先级为 **命令行参数 > 环境变量 > `manifest/config/config.yaml` > 内置默认值**。`LOOPRA_CONFIG` 或 `--config` 可指向其他进程配置。常用项：

| 设置 | 环境变量 | 说明 |
|---|---|---|
| 数据目录 | `LOOPRA_HOME` | 默认 `~/.loopra`。 |
| 端口 | `LOOPRA_PORT` | 未指定或为 `0` 时由系统分配空闲端口。 |
| 访问密钥 | `LOOPRA_ACCESS_KEY` | 缺省时每次启动随机生成。 |
| 前端目录 | `LOOPRA_STATIC_DIR` | 留空时用 `web/dist`，再是嵌进二进制的页面，最后才是 `<数据目录>/static`。 |
| 宠物目录 | `LOOPRA_PETS_DIR` | 默认 `~/.petdex/pets`。 |
| 调试日志 | `LOOPRA_DEBUG=1` | 默认只保留启动、对话、外部 Agent 和 API 错误。 |

监听地址默认 `127.0.0.1`。字段对照与加载规则见 [架构指南](docs/ARCHITECTURE.md#配置)。

## 使用方式

### Web 与桌面

`loopra` 不写子命令时启动 Web，`loopra web [port]` 等价。控制台输出带有本次启动密钥的访问地址。从该链接进入会验证密钥；页面上的 API 请求使用 `X-Loopra-Key`。静态页面无需密钥。服务重启会更换密钥，除非设置了 `LOOPRA_ACCESS_KEY`。

`looprax-desktop` 启动同一服务并打开工作台窗口，地址里自动带上密钥。文件、命令与系统目录操作发生在后端所在机器。

控制台日志是带颜色的固定列。`NO_COLOR` 或 `FORCE_COLOR=0` 关闭颜色。收到中断或终止信号后，应用停止后台任务并关闭 HTTP 服务。

### 聊天命令

Loopra Native 的常用命令如下。完整列表以界面命令菜单和 `/help` 为准。外部 ACP Agent 的命令由各自引擎提供。

| 命令 | 用途 |
|---|---|
| `/help` | 显示可用命令。 |
| `/new`、`/clear` | 回到当前工作区的新会话。 |
| `/sessions` | 浏览、导出或清理历史会话。 |
| `/export` | 下载当前会话的纯文本记录。 |
| 计划模式 | 输入框或 `/plan` 进入只读计划模式；`/execute` 批准待审查计划并按计划执行。 |
| `/compact` | 折叠历史上下文。 |
| `/goal ...` | 查看或管理当前会话 Goal。 |
| `/hitl`、`/agree`、`/deny` | 切换审批模式，或处理待审批工具调用。 |
| `/continue` | 继续当前任务。 |
| `/init` | 分析项目并生成 `loopra.md`。 |
| `/skills` | 为这条消息附加技能。 |
| `/terminal` | 在右栏打开命令面板。 |

### 输入框

输入框底部的常用要求保存在 `~/.loopra/prompt-presets.json`。点击预设会追加到当前输入。`@` 引用工作区文件，`Shift + Enter` 换行。过大的粘贴会先存到项目的 `.loopra/paste/`，再让 Agent 用 `read` 按需读取。生成期间可以停止当前回复。

### ACP

LoopraX 可以作为 ACP Agent 供外部编辑器连接。这条命令只占用标准输入输出，不启动 HTTP 服务，日志写到 stderr：

```bash
loopra acp
```

工作台里的 Loopra Native 会话不会拉起这条命令。协议由 `coder/acp-go-sdk` 实现。

在工作台中选择外部引擎时，Go 进程以 ACP v1 stdio 客户端驱动本机适配器。需要已安装的 Node.js，以及对应适配器：`@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`、`pi-acp`、`@deepseek-ai/dsh`。`GET /api/agent-engines` 会报告每个引擎的可用性与缺失原因。下面的环境变量可覆盖自动探测：

| 环境变量 | 作用 |
|---|---|
| `LOOPRA_NODE_EXECUTABLE` | Node.js 可执行文件。 |
| `CLAUDE_CODE_EXECUTABLE` | Claude Code 可执行文件。 |
| `LOOPRA_CLAUDE_ACP_SCRIPT` | Claude ACP 适配脚本。 |
| `LOOPRA_CODEX_ACP_SCRIPT` | Codex ACP 适配脚本。 |
| `LOOPRA_PI_ACP_SCRIPT` | Pi ACP 适配脚本。 |
| `LOOPRA_DSH_ACP_SCRIPT` | DeepSeek Harness ACP 适配脚本。 |

启动外部 Agent 时会把 `127.0.0.1`、`localhost` 和 `::1` 合并进子进程的 `NO_PROXY`，避免继承来的 `HTTP(S)_PROXY` 把发往本机推理网关的请求转走。会话通过 `.meta` 的 `agentId` 绑定引擎，ACP 转录写入同一份 `.jsonl` / `.events`。

### Java 兼容后端

Java `.jar` 插件和拓展包需要 Java 运行时。设置 `LOOPRA_JAVA_BACKEND_URL` 后，全部 `/api` 与 `/mcp` 流量交给该服务，包括聊天、历史、权限与引擎管理；Go 调度器不会启动。两边密钥不同时再设置 `LOOPRA_JAVA_BACKEND_KEY`。

## 从源码开发

### 前置条件

- Go 1.27.3（以 `go.mod` 的 `go` 行为准）
- Node.js `^20.19.0` 或 `>=22.12.0`
- pnpm 8+

### 后端

```bash
go test ./...
go run ./cmd/looprax
go run ./cmd/looprax-desktop
```

持续集成会执行 `go test -race ./...`、`go vet ./...` 和 `go build ./cmd/looprax`。目录职责、依赖装配和与 Spring 的概念对照见 [架构与开发指南](docs/ARCHITECTURE.md) 和 [用 Java 的感觉写 Go](docs/SPRING_STYLE.md)。

### 前端

```bash
cd web
pnpm install
pnpm dev
pnpm test
pnpm build
```

开发地址为 `http://127.0.0.1:3000/`，`/api` 代理到本机 `4567`。单独开发前端时先运行 `go run ./cmd/looprax 4567`，并在页面填入启动日志里的访问密钥。`pnpm build` 输出到 `web/dist`，供 Go 服务直接托管。

把页面嵌进二进制：

```bash
go build -tags webdist -o looprax ./cmd/looprax
go build -tags webdist -o looprax-desktop ./cmd/looprax-desktop
```

多平台打包脚本会先构建前端，再按 `scripts/package-matrix.txt` 写出 `bin/`。桌面端覆盖 Windows、Linux、macOS 的 amd64 与 arm64；macOS 产物是 `LoopraX.app` 和保持可执行权限的 zip。

```powershell
.\scripts\package.ps1
```

```bash
./scripts/package.sh
```

未签名的 macOS 安装包可能被 Gatekeeper 拦截。确认包来自本机构建后，可在终端执行 `xattr -cr` 指向该 `.app`，或在「系统设置 → 隐私与安全性」中选择仍要打开。

## 项目结构

```text
looprax/
├── cmd/looprax/            # Web 与 ACP 入口
├── cmd/looprax-desktop/    # 启动 API 并打开桌面窗口
├── internal/               # 应用本体
│   ├── bootstrap/          # 组合根与 HTTP 生命周期
│   ├── spring/             # 构造器注入的 IoC 容器
│   ├── controller/         # 路由、聊天、MCP、Git、需求
│   ├── service/            # 智能体、工具、审批、会话、ACP
│   ├── repository/         # config.json 与 JSON 文件
│   ├── model/              # 与 Loopra 兼容的配置和实体
│   └── infrastructure/     # 日志、路径、Git、内置 ripgrep
├── adk/                    # 模型协议适配与 JSONL 会话
├── web/                    # React 工作台
├── manifest/config/        # 进程配置 config.yaml
├── docs/                   # 架构、工具与 API 契约
├── scripts/                # 多平台打包
└── .github/                # 后端测试
```

`cmd/looprax` 是唯一的产品入口。HTTP、配置与日志由 GoFrame 的 `ghttp`、`gcfg`、`glog` 承载；智能体循环使用 ADK Go。`internal/bootstrap` 集中注册依赖，Controller 和 Service 不从全局容器查找对象。

和 Java 版控制器的路由对照、已验证范围和剩余差异记在 [对齐审计](docs/API_PARITY_AUDIT.md) 与 [API 契约](docs/API_CONTRACT.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 核心 | Go、GoFrame、ADK Go、Spring 风格 IoC |
| Web | GoFrame `ghttp`、SSE |
| 工作台 | React、TypeScript、NextUI、Vite、Monaco |
| 桌面 | mygo 原生窗口 |
| 协议 | MCP、OpenAPI、ACP、Chat Completions、OpenCode 兼容网关、Responses、Anthropic Messages |
| 持久化 | JSONL 会话、`~/.loopra` JSON 配置、项目 Markdown |

## 许可证

[MIT License](LICENSE) © 2026 Sorghum

# Loopra API 对齐进展

更新：2026-10-28（Asia/Shanghai）。

参考来源：`C:\Users\15614\Documents\code\agent4j`，分支 `dev`，提交 `c9bee181`，Java web 控制器。运行时对比在隔离的 Java 21 进程中使用参考项目已有的编译产物。

`feat/adk-go-migration` 上的 31 个提交已快进合并到本地 `main` 的 `0d61567`。本次后续实现保留了原有的 MCP 与依赖变更。实现与其验证证据一并纳入版本管理。

## 覆盖范围与证据

- 清单：来自 23 个 Java API 控制器的 185 个 HTTP 方法/路径组合。静态 `/config.json` 与 MCP 协议端点不计入此数。
- 原先缺失/不可达的 38 条路由现已能到达处理器。一个回归测试覆盖 184 条清单项；原生目录选择器已注册，但因需要桌面交互而被排除在自动化之外。
- 只读差异探测：26/26 个端点在 HTTP 状态与递归 JSON 字段/类型形状上一致。实际运行结果见 `API_PARITY_RESPONSE_SHAPES.csv`。
- 行为差异探测：29 个场景，包括元数据、会话设置、模型/渠道校验、Native 选择器、计划状态、需求 CRUD 与禁用/部分调度更新。所有规范化后的响应在 `API_PARITY_SCENARIOS.csv` 中一致。
- 场景规范化会移除生成的 `id`、`sessionName`、`createdAt`、`updatedAt` 与 `nextRunAt` 字段。不比较模型输出、分词器数值、每条错误路径或全部 SSE 序列。
- 额外的原生集成测试覆盖真实工具调用、计划执行、工作树写入/回滚、定向中断、断连后继续、MCP 客户端/导出鉴权、权限传播、技能读取、OpenAPI 刷新、市场安装与更新器子进程。

路由覆盖率、响应形状一致与这些选定场景分属不同证据。它们并不表示已完成的 1:1 功能占比。

## 已实现行为

### 配置、项目与模型

配置变更以原子方式持久化，保留未知的 Java 配置项与已脱敏的密钥，并重建后续运行时。旧式扁平渠道、布尔型 HITL、字符串形式的模型条目与字符串价格值均可正确加载。项目选择、排序、重命名与删除按工作区哈希划分，包括旧式绝对路径。存在活跃后台任务时不允许删除其所属项目。

模型列表、远程模型发现、loopra.md、用量/看板与元数据刷新现已有实际实现。元数据索引遵循 Java 的 openrouter 来源与人民币换算。会话的模型/渠道/强度设置在首次访问时固定，请求级覆盖会持久化但不改变全局默认值。原生引擎的模型/模式/强度/快速/计划选择器与新会话偏好已接入执行。快速模式以 `service_tier=fast` 传递给 OpenAI 兼容提供商。

### 聊天、会话与存储

聊天强制校验重复请求 ID，每个项目/会话仅允许一个活跃轮次，16 个执行槽位与 64 个额外准入请求。HTTP 断连不会取消执行。中断与会话状态使用精确的请求标识。需求与定时轮次共享准入规则。

项目与派生的智能体共用同一个实际的 JSONL 服务，包括安装在 ADK Runner 中的服务。会话日志延迟创建：新建会话只在内存中登记并固定 `.meta` 设置，首条消息写入时才创建 `.jsonl`/`.events`，因此普通空白会话不会落盘、不会出现在列表里，也不会在重启后保留（与 Java `JsonlSessionStore` 的懒物化一致；只有显式开启计划模式或存在待执行计划的 `.meta` 会话会在刷新后重新出现，这是 Java `list()` 的既有例外）。历史保留工具/推理数据，审计事件在回滚后仍保留，快照标识记录在用户消息上。集合级 DELETE 会清除所选项目中的所有会话；清理返回 Java 的 `sessionNames` DTO。

计划模式限制暴露的工具；submit_plan、ask_choice 与 execute_plan 已接通。HITL 决策与工具设置会持久化。显式关联的项目根仅在该轮次内对文件工具可用。

### Git 与文件系统

工作树聊天将沙箱作为真实的工具根目录，遵循自定义工作树目录并保持父项目/会话标识。快照位置独立于后续模式变更而持久化；回滚不能从沙箱静默切换到主项目。私有 Git 索引在检查点期间保留部分暂存内容。AI 提交信息使用配置的模型生成，不再使用占位符。

文件支持原始图片响应、有界搜索、相对树路径、基于查询的删除与粘贴。工作区检查会解析符号链接与 Windows junction，包括尚未创建文件的祖先目录。Windows junction 回归测试无需管理员符号链接权限即可运行。

### 需求与调度

需求支持项目/模型覆盖、显式的完成/评论工具、审批、取消、并发上限 2 与自动扫描。定时任务按项目持久化，执行时带历史与结果，支持 cron/间隔/现有会话/独立会话，并在关闭时停止接受排队工作。CRUD 事务不再覆盖并发更新。Java 默认值、空数组、部分更新与应用级失败响应均已由差异场景覆盖。

### MCP、OpenAPI 与技能

MCP 的 stdio/SSE/streamable 客户端、请求头与拒绝工具设置均会到达模型轮次。按引擎的全局/项目开关生效。导出以真实 MCP 协议提供服务并带访问密钥校验；隧道代理仅暴露 MCP 端点。Cloudflared 进程控制已实现。

OpenAPI 来源支持带鉴权的 JSON/YAML 下载、持久化缓存、刷新/移除与关键词 AND 搜索。技能市场支持下载、安全的归档安装与卸载。技能元数据覆盖内置、用户、共享 `.agents` 与项目目录。原生 skilllist/skillsearch/skillread/skillrefresh 工具读取真实文档，工具元数据包含实际的参数声明。

### 系统集成与 Java 兼容

桌面应用检测、打开工作区、原生选择器、宠物/设置、发布检查与后台更新任务均有执行实现。更新器测试使用无害的本地脚本；内嵌安装脚本仅做语法检查。

外部 ACP 引擎由 Go 原生执行：`internal/service/acp` 实现了 ACP v1 的 stdio JSON-RPC 传输、`initialize/session.new/load/resume/prompt/cancel/set_mode/set_model/set_config_option`、`session/update` 归约、`session/request_permission` 审批桥接与进程树回收；`internal/controller/acp_runtime.go` 负责把更新转换为 Loopra 的 `content/reasoning/tool_call/tool_result/file_changes/acp_plan/acp_commands/config_options/usage/complete` 事件并写入同一套会话转录。探测支持 claude-code、codex、pi、dsh 四个提供方。

原生插件从 npm 包或 GitHub 地址安装，由 moejs 执行。配置 `LOOPRA_JAVA_BACKEND_URL` 后，完整的 `/api` 与 `/mcp` 执行上下文会一并委派，本进程不加载原生插件。`LOOPRA_JAVA_BACKEND_KEY` 提供其密钥。聊天、审批、会话、历史与引擎管理因此共享同一个后端，且 Go 调度器不会启动。鉴权与即时 SSE 转发已测试。

## 剩余的原生对齐缺口与未验证行为

1. 外部 ACP 引擎已原生可用，但会话分叉（`session/fork`）、ACP 提问（`elicitation/create`）、子代理原生 child session 与共享进程池尚未实现；Claude Code 的扁平化子代理转录已按 `parentToolUseId` 归约为 `sub_*` 事件。
2. 命令元数据与 Java 一致，但完整的斜杠命令分发器、Goal/清单执行与 AI 自动解决工作树冲突的策略仍不完整。保存 `mergeMode` 并不证明这些合并策略会执行。
3. 上下文 token 估算已明确标注为 UTF-8 近似值，并非 Java 的精确原生分词器。缓存计量与各提供商特有的上下文估算在数值上并不等价。
4. 185 个 API 尚未全部通过穷举的成功/错误/持久化/SSE 差异场景。缓存生命周期/上限、复杂的子会话分支、每个 OpenAPI/市场变体以及 MCP 工具名冲突仍需进一步验收。
5. 原生桌面交互与真实的公网 Cloudflared 隧道未做验证。原生选择器被排除在自动化路由测试之外。
6. 测试期间未下载或安装真实的发布二进制文件。发布打包、平台可执行文件替换与重启行为需要一次发布验收运行。测试仅验证无害的更新器进程、状态/日志生命周期与安装脚本语法。
7. Go 服务默认提供自行编译的 `web/dist`（与桌面同一套页面），也可用 `-tags webdist` 嵌进二进制。`<LOOPRA_HOME>/static` 只在没有这份产物时使用。

## 验证与复现

使用 `go.mod` 选定的 Go 版本：

```sh
go test ./...
go test -race ./...
go vet ./...
go build ./cmd/looprax
```

在本 Windows 机器上，竞态测试使用已安装的 LLVM 编译器，需设置 `CGO_ENABLED=1` 并使用带引号的 `CC` 路径。

`TestLoopraContractRoutesReachHandlers` 读取清单 CSV。`parity_test.go`、`runtime_tasks_test.go`、`skills_test.go`、智能体状态共享回归与 Git/路径测试提供针对性的执行覆盖。新的后端 CI 会以竞态检测器、vet 与构建运行根模块测试。

`scripts/` 下的 Python 脚本可针对一次性服务复现差异探测。它们从环境变量读取端点/密钥/工作区设置。变更脚本还要求 `LOOPRA_PARITY_ALLOW_MUTATIONS=isolated-fixtures`，仅创建自己的测试夹具并在结束时移除。不要对真实用户数据目录运行该脚本。两个脚本都不执行模型调用、真实更新或桌面操作。

两个差异服务均使用隔离的临时主目录与伪造的本地模型配置，并在验证后停止。其密钥、日志与原始私有响应体未存入本仓库。历史发现保留在 `API_PARITY_BASELINE_2026-10-27.md` 与清单的 Baseline 列中。`AuditHttpStatus`、`JavaLine` 与 `GoRouteLine` 保留原始审计证据；行号为历史值。

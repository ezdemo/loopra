# Loopra API 复刻核查

核查日期：2026-10-27。

对照源：`C:\Users\15614\Documents\code\agent4j` 的 `dev` 分支，
提交 `c9bee181`，`loopra/src/main/java/site/sorghum/loopra/web/controller`。

被核查代码：Looprax `0d61567`，包含工作区原有、未提交的 MCP 客户端修改。
本次已将 `feat/adk-go-migration` 的 31 个提交快进合并到本地 `main`，
两个分支均指向 `0d61567`。原有未提交修改已保留。

## 结论与口径

当前实现尚未达到所有 API 的 1:1 复刻。

- Java 源码中有 23 个提供 `/api` 接口的控制器，共 185 个“HTTP 方法 + 路径”组合。
- 已确认 38 个组合在 Go 服务中返回 404 或 405，属于缺失或分派不可达。
- 其余 147 个组合有对应路由/处理分支，但没有逐个通过兼容性验收，其中存在明确的占位实现及行为差异。
- 147 / 185（79.5%）仅代表扣除已确认缺失后的候选范围，不能作为功能完成率。
- `/config.json`、静态资源和 MCP 对外协议地址不计入这 185 个 REST API。

完整逐项清单见 [API_PARITY_AUDIT.csv](API_PARITY_AUDIT.csv)。
`missing` 表示已通过 HTTP 探测确认 404/405；
`present_unverified` 表示有对应处理代码，尚未完成逐项契约验收。
`GoRouteLine` 可能指向通配前缀路由，不能据此认定内部动作可达。

## 38 个缺失或不可达接口

### Agent：8 个

- GET `/api/agent/mode`
- POST `/api/agent/mode`
- GET `/api/agent/commands`
- GET `/api/agent/acp-state`
- GET `/api/agent/prompt`
- GET `/api/agent/project-capabilities`
- POST `/api/agent/project-capabilities/refresh`
- GET `/api/agent/skills`

### Chat：2 个

- GET `/api/chat/elicitations`
- POST `/api/chat/elicitation`

### Config、模型、工作区、用量：14 个

该 Java 控制器共有 16 个接口，Go 只注册了 GET/PUT `/api/config`。

- GET `/api/models`
- GET `/api/remote-models`
- POST `/api/remote-models`
- GET `/api/usage`
- GET `/api/workspace`
- POST `/api/workspace`
- GET `/api/workspaces`
- PUT `/api/workspaces/{hash}/name`
- DELETE `/api/workspaces/{hash}`
- PUT `/api/workspaces/order`
- GET `/api/workspaces/order`
- GET `/api/loopra-md`
- PUT `/api/loopra-md`
- GET `/api/usage/dashboard`

### Git：1 个

- POST `/api/git/generate-environment-commit-message`

`gitController` 没有该动作分支，虽然 POST `/api/git/` 已注册，仍返回 404。

### MCP：1 个

- POST `/api/mcp/export/refresh`

`mcpController` 没有该动作分支，返回 404。

### OpenAPI：2 个

- DELETE `/api/openapi/sources`
- PUT `/api/openapi/sources/refresh`

### Plugins：3 个

- GET `/api/plugins/external`
- POST `/api/plugins/external/{id}/remove`
- POST `/api/plugins/external/{id}/toggle`

后两个请求进入 external 分派后直接返回 404。

### Sessions：2 个

- POST `/api/sessions/{name}`
- DELETE `/api/sessions`

分别影响切换会话和集合级删除。

### SubSessions：1 个

- POST `/api/sub-sessions/{subSessionId}/chat`

虽然存在 `subSessionChat`，控制器先将 `{id}/chat` 整体当作 ID，
再因 ID 含 `/` 返回 404。当前实现实际接收的 POST `/{id}` 与 Java 契约不一致。

### System：2 个

- POST `/api/system/open-workspace`
- GET `/api/system/version`

`open-workspace` 注册了路由，但 `systemController` 没有对应处理分支，返回 404。

### Tools：2 个

- POST `/api/tools/{name}/auto-toggle`
- GET `/api/tools/{name}`

## 已有接口中的主要行为差异

### P1：配置更新返回成功，但不落盘，也没有重建运行时

位置：`platform/web/controllers.go` 的 `configController`。

PUT 只把补丁反序列化到 `s.cfg`，不调用配置保存、Agent 重新初始化或配置变更广播。
隔离环境实测：PUT 将 model 改成 `audit-config-not-persisted` 后，
GET 返回新值，但磁盘 `config.json` 仍为 `deepseek-v4-flash`。
Agent 的模型在 `agent.New` 中一次性组装，改动该配置对象不会替换运行中的模型。

GET 也只返回配置字段的子集，缺少 `modelChannels` 等 Java 配置视图字段。

### P1：项目、模型及会话设置没有完整接入聊天执行链

位置：`platform/web/chat.go`、`agent/agent.go`、`platform/web/permissions.go`。

聊天请求声明了 `workspaceHash`、`agentId`、`model`、`modelChannelId`、
`reasoningEffort`、`fastMode`、`linkedProjectHashes` 等字段，
实际执行仍使用服务器启动时组装的同一个 Agent。
`execute_plan` 通过了参数校验，但没有对应的计划执行逻辑。

会话存储、历史查询、元数据及审批主要依赖固定的 `s.agent.App()` 或会话名，
没有按请求中的项目 hash 完成与 Java 一致的解析及隔离。
会话模型设置虽可写入 `.meta`，父 Agent 聊天执行没有读取这些覆盖值。

### P1：MCP 工具权限保存是假成功，导出和隧道缺少执行实现

位置：`platform/web/mcp.go`。

- `/servers/tools/save` 读取请求后直接返回成功，不保存禁用工具列表。
- `/servers/tools` 的 `disallowedTools` 固定为空。
- 实测为不存在的服务器保存权限也返回 200、`success:true`。
- `/export` 可以读写配置，但导出工具视图固定为空，当前路由表没有对外 `/mcp` 协议处理器。
- tunnel 的配置、启动、停止动作共用一个固定状态响应，没有保存配置或启动/停止进程。
- 实测 POST `/tunnel/start` 返回 200，但 `running:false`、`mcpReady:false`、`pid:0`。

工作区原有的 MCP 修改已经增加真实客户端连通性检查与工具列表查询，
不能把这些进展等同于导出服务、权限和隧道也已完成。

### P1：聊天并发准入、断连和状态查询与契约不同

位置：`platform/web/chat.go`、`platform/web/controllers2.go`。

- 相同 requestId 使用 `Store` 覆盖，没有重复 requestId 的拒绝逻辑。
- 未见契约要求的同项目/会话互斥及有界任务队列。
- 执行上下文来自 HTTP 请求上下文，客户端断开会取消执行；Java 契约要求断流后任务继续执行。
- session-status 用 `strings.Contains(requestId, sessionName)` 判断运行状态，
  requestId 通常是 UUID，不能正确判断指定会话是否运行中。
- session-status 的 JSON 没有 requestId，且尝试在响应已经写出后设置响应头。

### P1：撤回接口没有撤回会话历史，聊天快照事件也未创建快照

位置：`platform/web/snapshots.go`、`platform/web/chat.go`。

`rollbackCode:false` 时直接返回“会话消息已撤回”，未截断会话历史。
代码恢复分支也明确留下历史截断待实现的注释。
聊天开头发出的 snapshot 固定 `hasCodeSnapshot:false`，没有接入 checkpoint。

### P2：多组接口仍是占位或能力子集

- `platform/web/registry.go`：技能市场 proxy/detail/install/uninstall 返回 501；
  OpenAPI 注册返回 501，列表和搜索返回空数组。
- 同文件：插件、扩展包列表为空，安装返回“不支持 Java 插件/扩展包”。
  这是明确的能力缺口，不能作为 1:1 验收通过。
- `platform/web/controllers2.go`：打开应用列表和目录选择返回空值；
  模型元数据刷新只返回成功文案，没有实际刷新逻辑。
- 同文件：版本检查固定无新版本，更新接口只返回空闲状态。
- `platform/web/sessions.go`：current 固定空会话名，checklist/goal 固定空，
  evict-all 只返回成功，stats 固定为 0/50，fork 返回不支持 ACP 分叉。
- `platform/web/controllers.go`：会话列表标题固定为会话名，messageCount 固定 0，
  current/worktreeMode 固定 false，没有体现已保存元数据和实际消息数。
- `platform/web/engines.go`：只支持 native，prepare 不实际创建会话，
  对传入 agentId 没有完成与 Java 一致的引擎选择。

以上是本次确认的主要差异，不是剩余 147 个接口的完整缺陷清单。

## 验证与限制

- 使用本地 Go 1.27.3 执行根模块 `go test ./...`，全部通过。
- 使用当前源码重新构建了临时审计二进制。
- 在独立临时 `LOOPRA_HOME`、随机本机端口上，通过鉴权逐项请求了上述 38 个端点：
  全部返回 404 或 405，具体状态保存在 CSV 中。
- 另外实测了配置更新未落盘、MCP 权限保存假成功、隧道启动无实际启动、技能市场返回 501。
- 临时服务已停止；没有调用真实模型，也没有操作用户实际的 Loopra 数据。
- 现有测试主要验证 Go 自身的预期行为，测试通过不代表 Java/Go 差分契约测试通过。
- 本次没有对 Java 服务进行运行时差分测试，也没有逐项验证剩余端点的所有响应字段、
  错误码、SSE 事件和持久化兼容性。

## 后续修复顺序

1. 补齐配置、模型、项目管理的 14 个接口，并实现配置落盘和运行时切换。
2. 贯通项目隔离、会话选择、模型覆盖、聊天并发准入和断流后的后台执行。
3. 修复已注册但分派不可达的接口，补齐其余缺失端点。
4. 完成 MCP 权限、导出服务、隧道，以及撤回时的历史截断。
5. 为 185 个端点建立差分验收，覆盖正常请求、非法请求、响应字段、持久化和 SSE。

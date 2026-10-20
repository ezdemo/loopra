# Native ACP 接入

本阶段让现有 Web / Electron 主聊天通过 ACP v1 使用 Loopra Native。

```text
React / Vue → /api/chat/stream → AcpWorkbenchClient
                                      ↓ JSON-RPC
                               LoopraAcpAgent
                                      ↓
                           AcpSessionBackend → LoopraAgent / Cutin
```

## 会话与连接

工作台继续拥有项目、会话索引、快照和 Worktree。Native 会话继续使用现有
`SessionAgentRegistry`、`SessionAgentFactory` 和 `SessionTurn`，保留模型设置、
执行目录、计划执行、持久化和资源清理行为。

当前主聊天每回合建立一个私有的进程内 ACP 连接，并绑定已经存在的工作台会话。
`JsonRpcLoopback` 对每条消息进行 JSON 序列化和反序列化，交由 ACP SDK 路由，
不直接调用服务端处理方法，也不额外启动 JVM。连接 ID 是临时绑定，持久会话身份
仍由工作台的项目和会话名决定。关闭连接不会删除或丢弃 Native 上下文。

`AcpWorkbenchClient` 接受标准 `AcpClientTransport`；未来外部进程可以使用 SDK 的
stdio transport，并由 Hub 持续保存每个 Agent 的连接和远端 Session ID。

## 标准事件与 Native 扩展

- 文本、思考、工具调用和工具结果使用标准 `session/update`。
- 工具使用引擎提供的 `toolCallId`，结果携带明确的完成或失败状态。
- 权限使用 `session/request_permission`；审批结果返回原来的 ACP 请求。
- 取消使用 `session/cancel`，包括释放待处理审批并等待 Native 回合清理。
- 独立 ACP 服务支持新建、加载、关闭和列出活跃会话；加载时回放历史。

双方在 initialize 的 capabilities `_meta` 中声明 `loopra.dev/workbench: true` 后，
Native 将子代理、文件改动摘要、计划、用量、重试和完整回复等工作台事件放入
`agent_message_chunk._meta["loopra.dev/event"]`，格式为 `{type, data}`；正文为空，
`data` 是原事件的 JSON 字符串。未协商该扩展的客户端只接收标准交互。

这些扩展保留 Native 已有功能，不代表其他 ACP Agent 必须提供同样的工具或能力。

## 审批接口

`POST /api/chat/permission`：

```json
{
  "workspaceHash": "项目 hash",
  "sessionName": "会话名",
  "permissionRequestId": "choice 事件中的 ID",
  "optionId": "Agent 提供的选项值"
}
```

请求按项目、会话和审批 ID 查找，选项必须来自 Agent 的原请求。审批不产生新的聊天
消息或新的模型回合。完成、取消或连接释放后，审批不再可用。

`GET /api/chat/permissions?workspaceHash=...&sessionName=...` 返回当前未处理审批，
供 React 和 Vue 在页面刷新后恢复交互。`permission_resolved` 事件更新原审批卡片。

## 独立 stdio 服务

```sh
java -jar loopra.jar --loopra.acp=true
```

此模式在启动 Web 服务之前进入 `LoopraAcpMain`。stdout 专用于 ACP JSON-RPC，
普通输出和诊断转到 stderr。配置沿用 Native 的模型配置。WebSocket 启动方式保留。

## ACP MCP 配置

工作台在 `session/new` 发送合并后的全局和项目 MCP，Native 接收端支持
stdio、HTTP、SSE，并在 initialize 声明 `mcpCapabilities.http/sse`。
独立 ACP 服务也会读取自己的全局和当前项目配置，再按服务器名称合并客户端的
`mcpServers`（客户端优先）；`session/load` 会重新应用这份配置。

MCP 客户端归各个 Native 会话所有，不写回全局管理配置或项目文件。替换配置、
关闭会话和服务退出时释放对应客户端；stdio 子进程使用该会话的执行目录，环境变量
按 ACP 配置传递，工具参数不会混入 Loopra 的内部执行上下文。
Native 的工具禁用、只读覆盖、计划模式及权限审批继续由现有工具链处理。
配置变化会刷新 Native 的工具快照，避免旧 MCP 在移除后被文件扫描重新加入。

stdio 的全局管理、项目加载和 ACP 会话共用协议版本声明，支持协商
`2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`。
这修复了 Solon 4.1.1 stdio 默认只声明 `2024-11-05` 时，连接 Magpie 等返回
`2025-06-18` 的服务出现 `Unsupported protocol version` 的问题；未知版本仍会拒绝。

## 本阶段边界

迁移入口为当前前端的主聊天 SSE。历史查询、模型设置、计划管理等工作台 API 继续
使用原有服务；同步内部聊天、定时任务、需求执行和子代理继续对话尚未全部改为 ACP
Client 调用。通用 Agent 注册、外部进程管理、动态配置 UI 和 ACP v2 留待后续阶段。

后续阶段已增加 [Claude Code ACP 接入](acp-claude.md)：主聊天现在可选择本机 Claude，
并由独立的外部会话管理器持有 stdio 连接和远端 Session ID。

## 验证

`NativeAcpProtocolTest` 验证 JSON-RPC、工具 ID、明确失败状态、图片、扩展协商、
审批批准/拒绝/取消、错误响应、历史回放和真实独立 stdio 进程。
`AgentServiceTurnTest` 使用测试模型和工具验证当前工作台经过 ACP 后的 Native
审批恢复、拒绝、取消、计划、快照元数据和会话资源清理，不调用真实模型。

`AcpMcpServersTest` 验证全局/项目配置合并和三种传输映射；`AcpMcpToolSetTest`
通过真实 stdio MCP 子进程验证工具调用、cwd、环境变量、失败状态和进程释放。
`NativeAcpMcpTest` 验证 ACP 配置接收、恢复时移除工具、会话隔离和传输能力协商。
`McpClientFactoryTest` 使用固定返回版本的真实 stdio 子进程，验证各协议版本、
全局管理工具列表、项目加载、权限过滤和关闭后重新连接。

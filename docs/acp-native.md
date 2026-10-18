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

## 本阶段边界

迁移入口为当前前端的主聊天 SSE。历史查询、模型设置、计划管理等工作台 API 继续
使用原有服务；同步内部聊天、定时任务、需求执行和子代理继续对话尚未全部改为 ACP
Client 调用。通用 Agent 注册、外部进程管理、动态配置 UI 和 ACP v2 留待后续阶段。

## 验证

`NativeAcpProtocolTest` 验证 JSON-RPC、工具 ID、明确失败状态、图片、扩展协商、
审批批准/拒绝/取消、错误响应、历史回放和真实独立 stdio 进程。
`AgentServiceTurnTest` 使用测试模型和工具验证当前工作台经过 ACP 后的 Native
审批恢复、拒绝、取消、计划、快照元数据和会话资源清理，不调用真实模型。

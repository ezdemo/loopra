# 工具发现与动态调用

原生 Go 智能体保留核心工具，并通过两个固定入口使用 MCP：

| 工具 | 用途 |
| --- | --- |
| `tool_search(query, limit)` | 按服务、工具名、动作和描述检索，返回命中工具的完整定义 |
| `call_tool(name, arguments)` | 根据返回的限定名称调用目标工具 |

MCP 工具不再逐个加入模型请求的 `tools` 数组。该数组中的两个入口定义不包含动态的服务名清单，搜索、调用、搜索结果变化以及启用服务数量变化都不会改变入口定义。核心工具自身的配置或计划模式变化仍按原有规则生效。

## 调用流程

模型先搜索需要的能力：

```json
{
  "query": "idea find symbol references",
  "limit": 1
}
```

`tool_search` 返回匹配结果，例如：

```json
{
  "tools": [
    {
      "name": "idea/find_references",
      "server": "idea",
      "tool": "find_references",
      "description": "Find references to a symbol.",
      "parameters": {
        "type": "object",
        "properties": {
          "symbol": {"type": "string"}
        },
        "required": ["symbol"]
      }
    }
  ]
}
```

模型随后调用 `call_tool`：

```json
{
  "name": "idea/find_references",
  "arguments": {
    "symbol": "ConfigService"
  }
}
```

`parameters` 保留目标工具的完整 JSON Schema，包括嵌套结构、必填项和内部 `$ref`。搜索结果默认最多 5 个，`limit` 最大为 8；查询最长 512 个字符。检索使用服务名、工具名和描述的 BM25 排序，包含中文短语的二元切分，不需要额外调用模型。

`name` 使用“服务名 / 工具名”的限定引用；两个部分分别进行 URL 路径转义。因此同名工具可明确区分，工具原始名称也不受模型函数名长度或字符集限制。应直接使用搜索结果返回的 `name`。

模型可以直接复用对话中已经取得的定义，无需每轮重新搜索。未知、禁用或不可用的工具会返回错误，并提示重新检索。

## 上下文与缓存

完整定义通过 `tool_search` 的工具结果进入对话，后续请求继续追加调用和结果。后端不会因为某次搜索命中而新增函数声明，也不会维护需要不断扩大的“已加载工具列表”。

这消除了工具列表增删、重排导致的缓存前缀变化。搜索结果和聊天历史仍然占用上下文；实际缓存是否命中还取决于模型服务及请求的其他部分。

## 连接和权限

- 普通模型请求只取得固定入口，不连接 MCP，也不拉取远程工具目录。
- 首次搜索在后端列举启用服务的工具，最多同时处理 4 个服务；各服务沿用其配置的超时。
- 直接调用已知引用时，只加载目标服务。目录和连接在当前轮次复用，轮次结束后关闭。
- 用户级和项目级 MCP 合并、引擎启用开关、工具禁用名单、计划模式限制继续生效，调用时再次检查工具过滤规则。
- `call_tool` 在实际发送 MCP 调用前，用目标工具的 JSON Schema 校验 `arguments`。普通参数错误通过工具结果返回，模型可修正后重试。
- 执行仍委托原 MCP 工具，保留其人工确认和传输元数据处理。审批策略使用限定名称，例如 `idea/read`，避免远程同名工具继承原生 `read` 的分类。
- `disallowedTools` 仍填写 MCP 原始工具名；按工具配置审批覆盖或自动白名单时，使用上述限定名称。

单个服务失败不会阻止健康服务的检索；结果通过 `unavailableSources` 报告失败服务名，不将连接错误中的地址或凭据带入模型上下文。

## 代码与验证

`internal/service/toolsearch` 负责固定入口、检索、路由和参数校验；`internal/controller/mcp_client.go` 负责注入当前工作区允许访问的 MCP 服务和审批策略。

验证入口：

```bash
go test ./internal/service/toolsearch
go test ./internal/controller -run 'TestMcpBroker|TestEngineMcpPreferencesReachModel'
go test ./...
```

集成测试使用 130 个 MCP 工具，逐请求比较序列化后的 `tools` 数组，覆盖搜索返回完整定义、无效参数在本地拒绝并重试、动态执行、跨轮直接调用、服务开关和禁用名单，以及人工批准和拒绝。

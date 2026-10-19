# Magpie 集成

[Loopra Agent 插件](https://github.com/ezdemo/magpie-agent-loopra) 将 Loopra 接入 Magpie，支持模型、能力信息、自动推理强度、辅助模型及资源库同步。

```sh
magpie plugin add github:ezdemo/magpie-agent-loopra
```

在 Magpie 的 Agent 页面选择 Loopra 模型；在资源库里给 Loopra 勾选需要的技能、统一指令与 MCP。

| 资源 | Loopra 路径 |
| --- | --- |
| 模型、推理强度、辅助模型 | `~/.loopra/config.json` |
| 技能 | `~/.loopra/skills` |
| 用户级统一指令 | `~/.loopra/loopra.md` |
| MCP | `~/.loopra/mcp-servers.json` |

技能和用户级提示词沿用既有入口。更新技能后可刷新技能池；模型与全局 MCP 更新后重启 Loopra 服务，已有会话需重新选择模型或新建。

## MCP 配置兼容

Magpie 使用标准 `mcpServers` 对象；Loopra 管理页使用 `servers` 数组。现在全局管理服务及项目读取器合并读取两者，标准对象中的同名服务器优先，同时保留原生配置。禁用的服务器不会在全局服务初始化时连接。

管理页保存时，标准项保留在 `mcpServers`，原生项保留在 `servers`；标准项的未知扩展字段与文件的其他顶层字段保留。标准项不会被复制成原生项，因此从 Magpie 撤回资源后不会残留另一份连接。被同名标准项覆盖的原生配置也会保留，标准项移除后重新生效。

## 配置生命周期

模型连接与资源库分配独立：关闭模型连接会恢复 Magpie 接管的模型配置；撤回技能、指令或 MCP 时，需要在 Magpie 资源库取消对应的 Loopra 分配。用户原有内容由 Magpie 的资源库同步机制保留。

辅助模型与推理强度的默认选择、显式模型 ID 和关闭选项见插件的 `loopra-policy.js` 及 README。当前 Magpie Agent 插件接口不提供自定义设置控件。

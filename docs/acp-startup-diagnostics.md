# 外部 Agent 配置加载耗时诊断

首次读取配置会启动 ACP 连接并打开远端会话。第二次读取通常直接返回常驻客户端中的选项；两者执行的工作量不同。

## 获取分段日志

重新编译并重启 Loopra 后端后，打开一个尚未连接的 Codex 或 Claude 会话。控制台会输出：

```text
[acp-startup] trace=1 agent=codex operation=read cold=true adapterReused=false success=true totalMs=1716 phasesMs={...}
```

- `trace` 是本次后端进程内的诊断序号，不是访问密钥或远端会话 ID。
- `cold=true` 表示这次操作需要创建客户端；后端重启、连接淘汰或 MCP 修改都可能触发。
- `adapterReused=true` 表示新的会话客户端复用了已初始化的适配器，`initialize` 应接近 0。它不表示 Claude 的会话内 CLI 也被复用。
- 冷连接、失败以及超过 1 秒的请求使用 INFO 日志；普通热读取使用 DEBUG。
- 新增日志只记录阶段名、耗时和结果，不记录项目路径、会话名、消息或配置值。这个约束不改变其他既有日志的行为。

| 阶段 | 所包含的工作 |
|---|---|
| `storeOpen` | 打开本地会话存储 |
| `environment` | 解析执行目录，隔离分支模式下可能创建 worktree |
| `acquire` | 取得连接，达到 8 个连接上限时可能淘汰并清理旧进程 |
| `mcpConfig` | 读取受管 MCP 配置，配置变化时可能清理旧连接 |
| `clientCreate` | 检测运行时、创建 ACP 传输及客户端 |
| `historyCheck` | 检查本地历史是否为空，判断能否恢复远端会话 |
| `initialize` | ACP 协议握手 |
| `sessionResume` | 恢复远端会话，不要求回放历史 |
| `sessionLoad` | 恢复会话并回放历史，兼容不支持 resume 的 Agent |
| `sessionNew` | 创建尚无可恢复历史的远端会话 |
| `bindingPersist` | 保存远端会话绑定 |
| `restoreOptions` | 对比并恢复保存的模型、权限等选项 |
| `configReadOrWrite` | 读取内存选项，或者向 Agent 提交配置修改 |
| `storeClose` | 关闭本地存储 |

日志不是逐项完整的 CPU profiler：总耗时还包含监听器准备、调度、清理等未单独计时的工作。

## 配置读取的恢复方式

已有会话读取配置时，只有 Agent 在 `initialize` 中声明 `sessionCapabilities.resume`，才使用标准 `session/resume`。旧 Agent 继续使用 `session/load`。首次发送消息直接打开旧会话时保留原来的历史回放行为。

这可以避免为了显示模型和权限选项而传输整份历史，但不会消除 CLI 初始化、鉴权、MCP 和远端线程恢复的工作。会话占用错误继续返回冲突，不改成创建新会话。

## 2026-10-24 本机诊断

独立诊断使用已存在的会话，不发送提示词、不创建新远端会话。Loopra 元数据写入在诊断包装器内保留于内存；没有复制用户历史或访问密钥到诊断文件。

安装版本：Codex ACP 2.1.1、Claude ACP 0.93.0。适配器内的分段通过临时 Node 模块加载钩子测量，没有修改已安装包。

- Codex 样本：鉴权检查约 576 ms、恢复线程约 772 ms、模型列表约 4 ms、历史发送约 35 ms。
- Claude 样本：CLI 初始化约 1143 ms、设置读取约 24 ms、模型整理约 17 ms；历史读取与初始化存在并行，不能相加。
- 两个样本的 Loopra 受管 MCP 数为 0；这不表示原生 CLI 自身没有 MCP 或插件。
- 历史回放分别产生 382、730 条通知；使用 resume 后为 0。

同一组会话在独立 Java 进程中的一次顺序对照：

| 配置读取 | 原 load | resume |
|---|---:|---:|
| Codex 冷连接 | 1859 ms | 1716 ms |
| Claude 冷连接 | 2176 ms | 2333 ms |
| 两者热读取 | 约 1–2 ms | 约 1–2 ms |

这是单轮结果，Claude 的耗时没有改善，不能据此声称显著加速。确定减少的是历史传输和解析工作。此前 IDE 后端接口出现的 7.8–8.9 秒未在这轮独立进程中复现；应使用 IDE 进程实际输出的分段日志继续核对，不能把差值直接归因于某个插件或网络请求。

## IDE 后端的实际日志核对

用户于 20:56 提供 Codex 日志，并确认页面打开后连续选择了不同会话：

| 操作 | 总耗时 | 创建客户端 | 握手 | 建立或恢复会话 |
|---|---:|---:|---:|---:|
| 首页新草稿 | 5255 ms | 1299 ms | 2006 ms | 1865 ms |
| 第一个旧会话 | 5029 ms | 459 ms | 2142 ms | 2301 ms |
| 第二个旧会话 | 2809 ms | 147 ms | 930 ms | 1650 ms |
| 第三个旧会话 | 2908 ms | 138 ms | 1214 ms | 1481 ms |

根据完成时间减总耗时，前两次请求分别始于 20:56:41.801 和 20:56:42.767，重叠约 4.3 秒。对应注册数据也有一个空草稿和三个有历史的独立会话；这不是同一会话反复冷启动。首页自动准备在用户随后选择旧会话时，可能形成额外的并发准备工作。

前三个主要阶段占请求时间的 96%–98%。本地目录准备只需 0–8 ms，历史检查 0–15 ms，配置恢复 19–54 ms。`mcpConfig` 只测 Loopra 的配置读取与连接刷新，不能用它的低耗时排除原生 CLI 内部 MCP 启动的影响。

IDE 后端运行 Java 17，带调试器和 instrumentation agent。使用同一个 Java 17 单独复测，Codex 冷读取约 2781 ms（客户端创建 284 ms、握手 420 ms、远端恢复 1997 ms），接近 IDE 后两次的总耗时。因此不能仅凭 IDE 使用调试器就把它认定为主因。首次类加载、并发准备和外部 CLI 的耗时波动仍需受控实验才能分别量化。

## 握手内部的独立测量

使用只插入少量时间戳的 Node 加载钩子，不使用 TypeScript AST 转换，以降低测量本身对启动时间的影响。一轮 Codex 初始化共 489 ms：约 217 ms 时适配器收到 ACP initialize 并转发给 app-server，约 489 ms 时收到 app-server 的响应并返回客户端。全程没有建立会话或发送提示词。

独立 Java 17 诊断中，Codex initialize 约 375 ms，其中请求发出后到 transport 收到并解码响应约 178 ms、响应转成 SDK 类型约 12 ms；本轮所有 `convertValue` 累计约 139 ms，包含发出请求前的能力参数转换。这些嵌套指标不能直接与 initialize 相加。

补充对照：

- 同一份适配器默认经 Node CLI 启动器运行所附 Codex；使用该版本所附的同一原生二进制作临时 `CODEX_PATH` 对照，三次握手中位数约从 369 ms 降到 297 ms。差值只有约 72 ms，不能解释 IDE 中的秒级等待，未据此改变正式启动路径。
- 同一 Java 进程连续重建三次 ACP 客户端，对照默认独立 JSON mapper 与共享 mapper。热 JVM 下 Codex 默认握手约 323–324 ms，共享 mapper 约 311–313 ms；收益约十余毫秒。首次 mapper 仍需完成类型准备，未据此加入全局 mapper 共享。
- Java 时间测量使用临时 transport 包装器和 mapper 代理，未修改正在运行的 IDE 后端或已安装适配器，也没有输出原始协议数据。

这些改造前的结果说明握手阶段同时包含新进程就绪和协议初始化，不能把整个计时当成一次普通的本机消息往返。后续已实现适配器复用，详见下文；Claude 的会话内 CLI 仍然独立。

## Claude 两层初始化的关键区别

用户 21:28 提供的两个 Claude 请求分别耗时 3261、3155 ms；两次没有重叠。平均 `initialize` 801 ms（25%）、`sessionResume` 2051 ms（64%）、`restoreOptions` 207 ms（6.5%）。目录与历史检查接近 0，不能用首页并发或重复读取历史解释这两次等待。

对该时间段实际会话做独立内部测量，`session/resume` 约 1098 ms，其中 CLI `control_request.initialize` 等待约 1029 ms，设置读取 17 ms，历史尾部读取约 3 ms，模型整理约 6 ms。这次独立运行未复现 IDE 的 2 秒，但主要等待已经落在 SDK 的 `query().initializationResult()`，而不是外层 ACP 协商。

完整 Java 配置读取的补充测量为 2224 ms：外层 initialize 694 ms、resume 1033 ms、配置恢复 173 ms。内层 CLI 初始化控制请求约 899 ms，恢复中的 `apply_flag_settings` 约 157 ms；异步 `get_context_usage` 约 256 ms，不能直接与前面各阶段相加。

两层含义不同：外层 ACP initialize 负责客户端与适配器的协商；随后 session/resume 才通过 Claude SDK `query()` 启动这个会话的 Claude CLI，并等待它的初始化响应。仅预热外层 ACP 适配器不能消除内层 CLI 的等待。当前“读取配置”接口需要先完整准备 Agent 会话，这个同步依赖才是进一步优化的重点。原生 CLI 内部的插件、MCP、认证等具体占比尚未测出，不能笼统认定其中某一项为主因。

## 已实现：同一执行环境复用已初始化的适配器

`SharedAcpProcesses` 按 Agent、规范化执行目录、关联目录列表和完整受管 MCP 定义划分进程组。只有具备远端身份且本地有真实历史的已有会话参与复用；新草稿与分叉继续使用私有进程。尚未完成 initialize 的进程不接纳新客户端，不支持独立 `session/close` 的旧 Agent 也不复用。

每个会话仍拥有独立的 `AcpWorkbenchClient`、配置、审批、输出与取消状态。共享层改写客户端请求 ID，按根会话和已宣布的子会话身份路由通知与 Agent 请求；未知会话的输出不会广播到其他会话。连接级 auth 状态仍按连接广播。

关闭一个客户端时只发送该会话的 `session/close`；最后一个会话离开后关闭适配器并等待子进程释放句柄，避免遗留进程占用项目或 worktree。关闭失败的进程不再接纳新会话；其他已有会话可继续使用，最后一个释放时回收进程。传输故障会完成全部待处理请求，后续请求重建进程。进程组和会话客户端均受上限约束，不增加后台预热或空闲常驻进程。

本地历史存在性检查增加 `SessionStore.hasMessages`，JSONL 实现逐行读取，遇到第一条有效且非内部通知的消息即返回。配置读取不再为这个布尔判断解析整份历史。

独立 Java 17 的同项目两个不同会话对照：

| Agent | 第二个会话使用独立适配器 | 复用适配器 | 适配器进程数 |
|---|---:|---:|---:|
| Codex（首轮成功对照） | 1436 ms | 182 ms | 2 → 1 |
| Claude（三轮中位数） | 1761 ms | 1189 ms | 2 → 1 |

后续 Codex 重复样本遇到另一个客户端占用远端会话，未纳入统计；没有通过新建或分叉绕过 writer 冲突。所有独立诊断都不发送提示词，Loopra 元数据修改留在诊断包装器的内存中。

用户重启 IDE 后端后的实际日志确认：

- Codex `adapterReused=true`：总耗时 224、210、525 ms，initialize 都约 1 ms，sessionResume 分别约 165、146、410 ms。
- Claude 首个旧会话 2606 ms（initialize 820 ms、resume 1466 ms）；复用后的另一个旧会话 1880 ms（initialize 0 ms、resume 1664 ms、恢复选项 196 ms）。

该次 IDE 重启同时开启 wall profiler，且与独立重复诊断有时间重叠，因此最初并行启动的 7–8 秒不用于冷启动前后对照。复用只减少后续兼容会话的实际初始化工作，首个进程的冷启动仍存在；Claude 的内层 CLI 仍需约 1–2 秒，未用静态配置或界面缓存掩盖它。

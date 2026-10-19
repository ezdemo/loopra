# Loopra 模块化改造记录：从 loopra-bin 拆分到 Agent 定制接口

> 分支：dev　日期：2026-08-04　版本：26.8.3.2（Solon 4.0.4）

## 0. 改造总览

**目标**：把单体 `loopra-bin` 拆成可独立发布的模块，内核（loopra-model）压薄为纯推理内核并依赖倒置，
最终让 Agent 门面（LoopraAgent）的关键协作者可被 loopra-web 等上层模块注入定制。

### 提交时间线

| 提交 | 时间 | 说明 | 规模 |
|------|------|------|------|
| `d50ea729` | 08-04 01:10 | refactor: 将 loopra-bin 拆分为可独立发布的 loopra-model / loopra-harness / loopra-acp 模块 | 295 文件，+1019/-529 |
| `5d0ba46a` | 08-04 04:38 | refactor: loopra-model 压薄为纯内核，编排设施下沉 loopra-harness 并以 SPI 倒置 | 69 文件，+433/-94 |
| `6f1c367b` | 08-04 09:21 | refactor: LoopraAgent 开放 goalGuard/toolPolicyProvider/sessionStore 注入点支持上层定制 | 4 文件，+86/-9 |
| `0d3fa6b5` | 08-04 09:31 | docs: LoopraAgent 定制接口改造记录与遗留清单（本文档初版） | 1 文件，+150 |
| `a8eb4c42` | 08-04 09:34 | docs: 文档更名为 loopra-modular-refactor.md 并扩写为全程记录 | 1 文件，+239/-150 |
| 待提交 | 08-04 10:15 | refactor: ToolSystem 注入点 + SessionStore 生命周期归属（遗留 5.1/5.2 解决，阶段四） | 6 文件，+404/-13 |

### 模块依赖（已按 pom 核实）

```
loopra-web ──► loopra-acp ──► loopra-harness ──► loopra-model
     │                             ▲
     └─────────────────────────────┘（web 亦直接依赖 harness）
```

- **loopra-model**：纯内核，零 loopra 模块依赖
- **loopra-harness** → model
- **loopra-acp** → model + harness
- **loopra-web** → harness + acp（pom 中置顶，保证 shade 时补丁类优先）

---

## 1. 阶段一：模块拆分（`d50ea729`）

将单体 loopra-bin 物理拆分为三个可独立发布的 Maven 模块：

| 模块 | 定位 | 内容 |
|------|------|------|
| loopra-model | ChatModel/Agent/Tool 抽象内核 | agent/tool/hitl/context/tokenizer/memory 核心 + ToolScan SPI，零上层依赖 |
| loopra-harness | 内置工具全家桶 | builtin/lsp/mcp/skill/search/git/shell/zipreader 等，通过 SPI 装配到内核 |
| loopra-acp | ACP 协议适配层 | 隔离 ACP SDK 依赖 |

关键动作：

- loopra-web 仅依赖 loopra-acp，传递引入 harness/model（阶段二中 web 补充直接依赖 harness）
- AgentLoop 对内置工具的引用改为 `ToolSystemInitializer` SPI 注入
- loopra-web 资源过滤增加 ttf/otf/woff/woff2 二进制排除，修复前端字体资产构建失败
- 同步重建前端静态资产，修正 Help 页 `exec:java` 启动命令指向 loopra-web

## 2. 阶段二：内核压薄 + SPI 倒置（`5d0ba46a`）

### 2.1 loopra-model 仅保留纯内核

- 保留：model(ChatModel)/agent 推理内核/tool 抽象/session 的 `SessionStore` 接口与
  `SessionFileChangeTracker`/util
- 新增 `agent/spi` 四接口：**AgentConfig、GoalGuard、SessionUsageSink、ToolPolicyProvider**

### 2.2 编排设施下沉 loopra-harness（FQCN 不变，web/acp import 零改动）

LoopraAgent、goal/checklist/workspace/command、SessionService/JsonlSessionStore、
LoopraConfig/ConfigService/ConfigChangedEvent、AppConfig。

### 2.3 内核换型（面向 SPI）

- AgentLoop / SubAgent / ToolCallValidator / HitlManager / StormBreaker / ToolRegistry /
  AgentLoopController 改用 SPI 类型
- 删除 `LoopraConfig.getInstance()`、GoalService 硬依赖
- `getSessionService`/`setSessionService` 更名 `getSessionUsageSink`/`setSessionUsageSink`

### 2.4 装配关系

- `LoopraConfig implements AgentConfig`
- `SessionService implements SessionUsageSink`
- GoalGuardImpl / ConfigServiceToolPolicyProvider 由 LoopraAgent 构造时注入
- loopra-acp 依赖改为 loopra-harness（原依赖 model）

### 2.5 验证

- `mvn clean package` 全绿：model 145 / harness 122 / web 31 = 298 测试，0 失败
- fat jar 冒烟：health=ok、42 工具、index 与字体 200
- 正则扫描确认 loopra-model 对 harness/acp 包**零 import**

## 3. 阶段三：LoopraAgent 开放定制接口（`6f1c367b`）

### 3.1 背景

阶段二后 LoopraAgent 已下沉 harness，但构造时仍硬编码协作者的具体实现：

| 协作者 | 硬编码实现 | 所在模块 |
|--------|-----------|----------|
| Goal 守卫 | `GoalGuardImpl`（bin.goal） | harness |
| 工具策略 | `ConfigServiceToolPolicyProvider`（bin.config） | harness |
| 会话持久化 | `SessionService` 内部 `new JsonlSessionStore(sessionsDir)`（bin.session） | harness |

SPI 接口早已在 loopra-model（`AgentLoop.setGoalGuard(GoalGuard)`、
`ToolRegistry.setToolPolicyProvider(ToolPolicyProvider)` 均面向接口），只是注入口没放出来。

### 3.2 改动：Builder 新增三个可选注入点

原则：**开放注入点，默认值保持原行为，上层不注入则零变化。**

```java
LoopraAgent agent = LoopraAgent.builder()
        .config(cfg)
        .modelClient(client)
        // ↓ 三个新注入点，均可选
        .goalGuard(myGoalGuard)                 // 默认 GoalGuardImpl
        .toolPolicyProvider(myPolicyProvider)   // 默认 ConfigServiceToolPolicyProvider
        .sessionStore(mySessionStore)           // 默认 工作区会话目录的 JsonlSessionStore
        .buildLightweight();
```

| Builder 方法 | 接口类型（loopra-model） | 未注入时的默认回退 |
|--------------|--------------------------|--------------------|
| `goalGuard(GoalGuard)` | `bin.agent.spi.GoalGuard` | `new GoalGuardImpl()` |
| `toolPolicyProvider(ToolPolicyProvider)` | `bin.agent.spi.ToolPolicyProvider` | `new ConfigServiceToolPolicyProvider()` |
| `sessionStore(SessionStore)` | `bin.session.SessionStore` | `new JsonlSessionStore(workspaceManager.getSessionsDir(...))` |

装配逻辑在 `initSessionAndLoop`（签名改为接收 Builder）：

```java
this.sessionService = (b.sessionStore != null)
        ? new SessionService(ctx, b.sessionStore)
        : new SessionService(ctx, sessionsDir);
...
agentLoop.setGoalGuard(b.goalGuard != null ? b.goalGuard : new GoalGuardImpl());
registry.setToolPolicyProvider(b.toolPolicyProvider != null
        ? b.toolPolicyProvider : new ConfigServiceToolPolicyProvider());
```

### 3.3 SessionService 新增注入构造

```java
// 原构造保留，委托为默认 JSONL 存储
public SessionService(ConversationContext ctx, Path sessionsDir) throws IOException {
    this(ctx, new JsonlSessionStore(sessionsDir));
}

// 新构造：上层注入自定义 SessionStore
public SessionService(ConversationContext ctx, SessionStore store) {
    this.ctx = ctx;
    this.store = store;
    ctx.setSessionStore(store);
}
```

### 3.4 测试与验证

- 新增 `SessionServiceTest.usesInjectedSessionStore`：注入的 store 同时装配到
  `SessionService.getStore()` 与 `ctx.getSessionStore()`（同一性断言）
- `mvn clean package` BUILD SUCCESS：model 145 / harness 123 / web 31 = 299 测试 0 失败
- fat jar 冒烟：`/api/system/health` 200、`/api/tools` 42 个、`/index.html` 200
- 模块边界：三个 SPI 接口全在 model，model 未新增对上层依赖，默认装配全在 harness；
  web/acp/CLI 无需任何改动

---

## 4. 阶段四：ToolSystem 注入 + SessionStore 生命周期归属（待提交）

### 4.1 背景

阶段三遗留的两项（原 §5.1/5.2）：

- 每个 Agent 构造时完整重跑 `ToolSystemInitializer.initialize`（扫技能、建提示词）；
  web 的 `sharedToolRegistry` 从未传给 Agent，只服务 `isReady()` 与 /api/tools 列表
- `JsonlSessionStore.shutdown()` 不在 `SessionStore` 接口上，`dispose()` 也不调用，
  web LRU 每淘汰一个 Agent 就泄漏一组消费者线程/定时刷入 scheduler/writer

### 4.2 改动①：Builder.toolSystem 注入点（跳过 initialize）

- Builder 新增 `toolSystem(ToolSystemInitializer.Result)`；非 null 时构造器直接复用，
  跳过 `ToolSystemInitializer.initialize`
- **注入单位是完整 Result 而非单个 toolRegistry**（对原建议的修正）：构造器还需
  `initResult.promptPrefix` 构建 ConversationContext，只注入 registry 无法覆盖提示词前缀
- `ToolRegistry.refresh()` 加 `synchronized`：registry 共享后多 Agent 并发聊天会并发
  执行 refresh（清空 + 重扫），需同步防止 LinkedHashMap 结构损坏

```java
LoopraAgent agent = LoopraAgent.builder()
        .config(cfg)
        .modelClient(client)
        .toolSystem(sharedResult)   // 可选：注入后跳过内部工具系统初始化
        .buildLightweight();
```

### 4.3 改动②：web 按工作区共享工具系统

- AgentService 新增 `sharedToolSystems`（工作区绝对路径 → Result）缓存：
  `buildSharedComponents` 预构建默认工作区；`createAgent` 注入
  `.toolSystem(getOrCreateSharedToolSystem(workspace))`；`reinitialize` 清空缓存；
  非默认工作区按需懒构建
- `sharedToolRegistry` 字段保留（/api/tools、SubAgentController、isReady 使用），
  至此真正传给 Agent，原"冗余初始化"消除
- **工作区依赖**：工具扫描（Skill）、环境信息、项目文档均随工作区变化，
  故只按同一工作区共享
- 副作用（有意修正）：① `loadDefaultSystemPrompt` 拼接的 `~/.loopra/loopra.md` 以前
  只进入从未被使用的共享 registry，现在真正进入 Agent system prompt，
  `updateLoopraMd` 的"重建使新提示词生效"意图首次真实生效；
  ② disabledTools 取 Result 创建时的快照，热变更仍走既有 refreshTools 路径，
  但 reinitialize 前新建会话沿用旧快照（与旧行为差异可忽略，validator 始终实时拦截）
- ACP 侧 buildLightweight 不注入，零影响

### 4.4 改动③：SessionStore 生命周期归属

- `SessionStore` 接口新增 `default void shutdown() {}`；`JsonlSessionStore.shutdown` 加
  `@Override`（实现本就幂等，重复调用安全）
- LoopraAgent 记录 `ownsSessionStore`（`b.sessionStore == null` 即自建）；`dispose()` 在
  flush/saveUsage 之后**仅关闭自建 store**；注入的共享存储由注入方管理生命周期

### 4.5 测试与验证

- 新增 `LoopraAgentInjectionTest`（loopra-harness，3 例）：
  - toolSystem 注入：registry 实例 assertSame 装配进 AgentLoop + system prompt 含注入
    前缀 + stub ModelClient 完整聊天往返（同时补齐原 5.5 的装配测试缺口）
  - 注入的 SessionStore 不被 dispose 关闭（记录型 stub 计数）
  - 自建 JsonlSessionStore dispose 后 `consumerRunning=false`（反射读内部标志）
- 测试环境坑：① 无 Solon 容器的单测中默认 `ConfigServiceToolPolicyProvider` 会 NPE，
  需注入空策略替身；② DJL 分词器向 user.home 释放原生 DLL，用 @TempDir 隔离
  user.home 时 Windows 无法删除已加载 DLL 导致清理失败，须用手动临时目录
- **回归修复（实战暴露）**：初版 `buildSharedToolSystem` 在 `computeIfAbsent` 映射函数内
  又 `put` 同一 ConcurrentHashMap，首个 `listSessions → createAgent` 请求即招
  `IllegalStateException: Recursive update`。已改为纯构建函数，调用方自行 put；
  `AgentServiceSharedToolSystemTest`（loopra-web，2 例）守护首次构建/复用/多工作区独立
- `mvn clean package` 全绿：model 145 / harness 126 / web 33 = 304 测试，0 失败
- fat jar 冒烟：health=ok、工具 47（此前 42 为无 MCP 工具时的值，现环境加载了
  codegraph/context7 两个 MCP server）、index 200；`GET /api/sessions`（崩溃路径）200 无异常

### 4.6 与并行计划模式实现的兼容性

同期并行落地的计划模式（/plan /execute 真实化）与共享 registry 天然兼容：
`planMode`/`pendingPlan` 是 AgentLoop 的会话级字段；`filterReadOnlyTools` 返回新
ONode 不修改 registry；执行拒绝在 ToolCallValidator 之前硬拦。计划模式状态持久化
走 SessionStore 新增的 `setPlanMode/isPlanMode` 默认方法，均为按会话操作，不碰共享实例。

---

## 5. 架构红线与经验沉淀

后续修改内核/模块时必须保持的约定：

1. **三条解耦红线**
   - 工具来源只走 `ToolScanProvider` SPI（harness 的 SolonToolScanProvider @Init 自动安装）
   - 图片结果只走 `ImageToolResult` 文本协议（bin.agent.model）
   - 父输出传递只走 `ParentOutputHolder`（bin.agent.output）
   - 新增上层能力在 loopra-harness 实现、由 loopra-web 聚合
2. **包名保留**：loopra-bin 包名（`site.sorghum.loopra.bin.*`）不改，仅物理拆分，无 JPMS/包名迁移风险；
   但同名包跨模块（split package）已是既成事实，新增类不要再扩大该面
3. **版本脚本**：`bump-version.ps1` 需同步维护 model/harness/acp 三个 pom
4. **资源过滤坑**：loopra-web 资源 filtering=true 遇二进制字体（ttf/woff/woff2）报
   MalformedInputException，必须在 maven-resources-plugin 的 `nonFilteredFileExtensions` 排除；
   前端重建引入新二进制资产后需同步检查
5. **前端静态资产流程**：loopra-front 构建后同步到 loopra-web/src/main/resources/static
   （CI：`loopra-release` 仓库的 `.release/ci-sync-web-assets.sh`；本地：pnpm build 后复制 dist/renderer 内容并保留 static/config.json）
6. **HttpModelClient 坑**：不会自动补 `/chat/completions` 后缀，按渠道建 ModelClient 必须用
   `LoopraConfig.ModelChannel.apiUrl()`（toApiUrl 按 apiProtocol 规范化），不能用 baseUrl()
7. **测试隔离坑**：改 `user.home` 系统属性的测试必须保存原值并恢复，避免污染同 JVM 后续测试；
   且隔离目录不要用 @TempDir——chat 路径的 DJL 分词器会往 user.home 释放原生 DLL，
   被 JVM 加载后 Windows 无法删除，@TempDir 清理直接失败，改用手动临时目录
8. **共享 ToolRegistry**：web 的按工作区 Result 缓存被多个 Agent 共享；
   `ToolRegistry.refresh()` 已 synchronized；不要往共享实例上加按会话的可变状态
   （forceDeny/forceAllow、计划模式过滤等），按会话的状态放 AgentLoop/副本，
   子代理场景必须继续走 `copy()`
9. **ConcurrentHashMap 递归更新**：`computeIfAbsent` 的映射函数内严禁再写同一 Map
   （put/remove/clear），否则抛 `IllegalStateException: Recursive update`；
   映射函数应保持纯构建，缓存写入由调用方完成

## 6. 遗留问题与后续计划（按影响排序）

> 原 5.1（ToolRegistry 注入）与 5.2（SessionStore 生命周期）已在阶段四（§4）解决。
> 以下问题**未修复**，留待后续；1/2 等 web 有真实需求再做。

### 6.1 LoopraAgent 本身仍是具体类，"抽接口"目标只完成一半

- web 直接依赖具体类，无法替换/mock
- 700 行门面含大量透传方法（`addUsage` / `retryLast` / `rewind` …），泄漏内部结构

**建议**（有真实需求时）：抽 `Agent` 接口（chat / bindSession / setListener / setOutput / abort /
flushSession / saveUsage / dispose 等公共 API），LoopraAgent 作为默认实现。

### 6.2 SessionService 是具体类，会话编排逻辑不可换

注入点只解决了"存哪"，没解决"怎么管"：标题生成（截首条消息的启发式）、用量统计等仍钉死。
web 若想要 LLM 生成标题等定制，需进一步抽接口。

### 6.3 goalGuard / toolPolicyProvider 注入的测试证据仍偏薄

- 阶段四已补 `toolSystem` / `sessionStore` 注入的装配测试（LoopraAgentInjectionTest，
  其中 toolPolicyProvider 以空策略替身形式被注入使用）
- 但 `goalGuard` / `toolPolicyProvider` → AgentLoop/ToolRegistry 的装配同一性仍只有
  code-review 级证据（`loop` 字段私有无 getter，外部难断言），可沿用反射思路补齐

### 6.4 其他小问题

- 构造器硬读 `System.getenv("LOOPRA_SESSION")`（CLI 习惯泄漏，web 场景无害，bindSession 会覆盖）
- 每个 Agent 自注册 `config.changed` Dami 监听，靠 dispose 注销，漏调 dispose 会泄漏监听器
- 共享 Result 缓存无上限：工作区数量多时累积（每项仅工具定义 + 提示词，量小；
  reinitialize 清空），如有多工作区滥用场景再评估淘汰策略

## 7. 相关文件索引

| 文件 | 说明 |
|------|------|
| `loopra-harness/.../bin/agent/core/LoopraAgent.java` | Builder 注入点（含 toolSystem）+ initSessionAndLoop 装配 + dispose 归属关闭 |
| `loopra-harness/.../bin/session/SessionService.java` | (ctx, SessionStore) 注入构造 |
| `loopra-harness/.../test/.../session/SessionServiceTest.java` | 注入装配测试 |
| `loopra-harness/.../test/.../tool/LoopraAgentInjectionTest.java` | toolSystem/sessionStore 注入与生命周期测试（阶段四） |
| `loopra-model/.../bin/agent/spi/` | AgentConfig / GoalGuard / SessionUsageSink / ToolPolicyProvider |
| `loopra-model/.../bin/session/SessionStore.java` | 会话存储 SPI（含 default shutdown） |
| `loopra-model/.../bin/tool/ToolRegistry.java` | 工具注册表（refresh 已 synchronized） |
| `loopra-model/.../bin/tool/ToolSystemInitializer.java` | 工具系统初始化，Result 为注入单位 |
| `loopra-harness/.../bin/session/JsonlSessionStore.java` | 默认 JSONL 实现（shutdown @Override） |
| `loopra-web/.../web/service/AgentService.java` | web 侧 Agent 缓存/装配 + 按工作区共享工具系统 |

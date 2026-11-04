# Loopra 开发规范

本文件适用于整个仓库，供开发者与编码代理共同遵守。修改代码前先阅读相关模块及测试；子目录存在 `AGENTS.md` 时，额外遵守其局部约定。用户明确要求优先于本文件。

<!-- magpie:begin · written by magpie from its Library -->
Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
<!-- magpie:end -->

## 项目与目录

Loopra 是面向本地代码库的 AI 编码代理与工作台。后端采用 Go、GoFrame v2、自有 `internal/spring` 容器与 ADK Go；工作台采用 React 18、TypeScript、Vite、NextUI 和 Tailwind CSS。

| 路径 | 职责 |
| --- | --- |
| `cmd/looprax/` | CLI、Web、ACP 启动入口与参数处理 |
| `cmd/looprax-desktop/` | 桌面启动入口 |
| `internal/bootstrap/` | 应用组合根、依赖装配、启动与关闭 |
| `internal/spring/` | 容器与生命周期基础能力 |
| `internal/controller/` | HTTP 请求、路由、响应、SSE 与工作区上下文 |
| `internal/service/` | 业务规则、Agent、工具、审批、插件与任务编排 |
| `internal/repository/` | 文件持久化与原子替换 |
| `internal/model/` | 业务数据结构、配置模型与兼容序列化 |
| `internal/infrastructure/` | Git、文件路径、进程、日志、ripgrep 等系统能力 |
| `adk/` | 模型协议与 JSONL 会话适配 |
| `web/src/components/`、`web/src/layout/` | 业务组件与工作台布局 |
| `web/src/` | Hooks、状态归约、API 客户端、纯逻辑与样式 |
| `web/tests/` | Node.js 测试 |
| `plugins/`、`examples/plugin-source/` | 内置插件与外部插件示例 |
| `intro/` | 无需构建的静态介绍页 |
| `scripts/`、`manifest/`、`docs/` | 打包脚本、进程配置与技术契约 |

产品名使用 **Loopra**。Go module、命令源码目录等现有标识仍含 `looprax`，不要因名称不同进行无关重命名。

## 修改原则

- 先查看 `git status`，保留已有修改与未跟踪文件，不覆盖用户的工作。
- 优先用 `rg` / `rg --files` 定位实现，沿调用链确认状态来源、持久化位置及前端消费方式。
- 一次改动围绕一个明确目标；不夹带全仓格式化、依赖升级、目录搬迁或无关重构。
- 优先复用现有模块和组件。新抽象应解决实际重复或隔离外部依赖，避免提前建设通用框架。
- 修复根因。不要靠吞掉错误、放宽类型、跳过测试或关闭权限校验让检查通过。
- 修改公共字段、默认值或交互行为时，同时检查后端、前端、持久化、兼容适配和文档。
- 新增依赖前确认标准库和现有依赖是否已满足需求。前端统一使用 pnpm，并随依赖变更更新 `web/pnpm-lock.yaml`；Go 依赖变更同步维护 `go.mod`、`go.sum`。
- 源码和文档使用 UTF-8。注释说明原因、约束和兼容背景，避免重复代码字面含义；沿用所在文件的注释语言。

## 后端

### 分层与依赖

- 依赖方向为 `controller → service → repository / infrastructure`；各层可使用 `model`。底层不要反向依赖 Controller。
- Controller 负责请求解析、参数校验、工作区上下文、调用业务和响应转换。新增业务规则放入 Service，避免继续扩大 HTTP 处理器。
- 通过构造函数显式传入依赖，应用级依赖集中在 `internal/bootstrap/application.go` 装配；业务代码不查询全局容器，不通过字段注入绕过循环依赖。
- 接口由使用方按需定义，保持小而具体；不强制为每个结构体配接口，不使用无意义的 `Impl` 后缀。
- 区分进程级单例、工作区运行时、会话与单轮执行对象。后几类对象应有明确的所有者、取消与释放路径，不注册成进程单例。
- `internal/config` 管理进程启动设置；`internal/model/config` 管理可更新的业务配置。不要混用来源和生命周期。

### 代码与错误

- Go 文件提交前执行 `gofmt`。包名简短、小写；导出标识使用 PascalCase，内部标识使用 camelCase；遵循 `ID`、`URL`、`HTTP` 等缩写写法。
- 文件按业务职责拆分，测试与实现同包或相邻组织；避免新增笼统的 `utils`、`common` 大杂烩。
- 预期内的业务、IO 和外部调用失败返回 `error`；需要补充上下文时使用 `%w`，以便调用方通过 `errors.Is` / `errors.As` 判断。
- 不将普通失败转成 `panic`。不要忽略写入、关闭或子进程退出错误；确需忽略时说明原因。
- 对外错误沿用现有响应结构与稳定的 `reason`，内部日志保留排查上下文，不向用户泄漏密钥和原始敏感请求。

### 并发与生命周期

- 请求链与外部调用传递 `context.Context`。需要脱离请求存活的后台任务，显式绑定应用、会话或任务生命周期。
- goroutine、定时器、流、监听器和子进程必须有退出与清理路径；关闭操作应能安全重复调用。
- 共享 map、配置和运行时状态使用锁、不可变快照或既有并发结构保护；返回快照时不要暴露可变内部引用。
- 不在无保护的读改写之间丢失更新。配置变更先完成持久化，再发布新状态；保存失败保留旧状态。
- 会话任务、审批、后台 shell 与子代理按工作区和会话隔离，取消时校验轮次身份，旧请求不能终止新一轮任务。

## API、流与存储

- 新路由在对应 `internal/controller/routes_*.go` 注册，沿用 `apiRouter`、`readRoute` 和现有处理器适配方式。只读路由保持 GET / HEAD、405 / `Allow` 与尾斜杠语义一致。
- 普通 API 沿用 `{ success, data?, error?, reason? }` 包装；SSE 与二进制端点按各自契约处理。复用现有响应辅助函数。
- 鉴权、CORS、工作区上下文和错误恢复沿用公共中间件，不在新端点另建一套规则。
- 修改 SSE 时同时检查发送端、`web/src/backend.ts` 的解析与缓冲、聊天状态归约、历史恢复。保持事件类型、字段、顺序和终止语义一致。
- 明确区分连接断开、用户取消、模型失败与正常结束；不要把 SSE 断开直接等同于终止后台 Agent。
- 并行工具结果按 `toolCallId` 关联，完成后及时发送，避免重复结果；子代理事件和文件变更保留所属子会话身份。
- JSONL 保持既有 snake_case 字段；HTTP / SSE 字段沿用各自现有命名，不做全局命名转换。
- 保持 `~/.loopra` 配置、JSONL 会话和伴生文件的兼容性。更新 `.meta` 或可扩展配置时保留未知字段；`.events` 是追加式审计记录，不随历史重写或回滚截断。
- JSON 配置和元数据优先复用临时文件加原子替换的写入能力；同一文件的读改写在同一同步边界完成，避免半文件和并发覆盖。
- 新增持久字段时定义缺省值，验证旧数据可读取、新数据可往返；不自动清空损坏数据或用默认值掩盖加载失败。
- 契约变更需同步实现、消费者、回归测试和对应文档。历史迁移文档与现有代码不一致时，先核对当前测试与调用方，再明确记录修正。

## 前端

### 架构与职责

前端是 Vite 驱动的 React 单页工作台，浏览器与桌面窗口复用同一套界面。沿用当前技术栈：React + TypeScript、NextUI（`@nextui-org/react`）、Tailwind CSS、业务 CSS、Lucide 图标和 Framer Motion；具体版本以 `web/package.json` 与锁文件为准。

| 模块 | 职责与使用边界 |
| --- | --- |
| `main.tsx` | 挂载 React、启动配置、访问密钥协议、主题初始化与全局样式入口 |
| `App.tsx` | 工作台组合、当前工作区和会话选择、页面与面板协调；新增功能优先提取到业务组件与 Hook |
| `layout/` | Sidebar、Header、HomeView、ChatDock 等布局与导航，通过 Props 接收数据和动作 |
| `components/` | 聊天、设置、文件、Git、需求、插件等业务视图；每个组件聚焦一个可描述的职责 |
| `components/ui.tsx` | IconButton、LoadingSkeleton、Segmented 等跨业务基础组件 |
| `components/SettingControls.tsx` | 设置表单的行、输入、选择、开关、分段与折叠等统一控件 |
| `components/RemoteControls.tsx` | 通用远程加载、错误展示和操作确认；适合简单资源读取与动作反馈 |
| `useLoopra.ts`、`useSessionPanel.ts`、`useWorkspaceSelection.ts` 等 | 后端连接、数据加载、选择同步与业务状态生命周期 |
| `backend.ts` | LoopraClient、API 类型与转换、SSE 解析、缓冲及事件处理等协议适配 |
| `chat.ts`、`composer.ts`、`session-runs.ts`、`workspace-tabs.ts` 等 | 消息、输入、轮次和标签页等领域类型与状态逻辑 |
| `document-theme.ts`、`workspace-theme.css`、`components/Motion.tsx` | 主题应用、语义样式变量、NextUI Provider 与统一动效偏好 |
| `desktop-*.ts`、`runtime-config.ts`、`access-key.js` | 桌面桥接、运行环境与访问协议，隔离平台差异 |

数据流保持清晰：用户操作由组件回调进入业务 Hook 或协调层，经 `LoopraClient` 请求后端，再将响应或 SSE 事件转换为业务状态，通过 Props 驱动视图。组件展示的数据应能追溯到明确的状态所有者。

- 临时展开、悬停、编辑等状态留在就近组件；兄弟组件共享状态提升到最近共同父级，复杂会话流程交给专用 Hook 或既有状态模块。
- 区分服务端资源、会话执行状态、表单草稿和 UI 偏好。服务端响应先经过协议适配，不让组件到处兼容同一字段的多种旧格式。
- Props 显式传递数据与业务动作，避免暴露整个 App 状态或大量无关 setter；Context 用于确实跨层共享的能力和偏好，不作为默认状态容器。
- 逻辑模块不反向依赖业务视图，协议与状态转换不依赖 DOM；DOM 测量、焦点和平台桥接集中在对应 Hook 或适配模块。
- 当前页面、侧栏与面板由工作台状态协调。新增视图先接入现有导航与标签页机制，不另建平行的页面状态或路由入口。
- 编辑器和文档解析等重依赖沿用 `monaco.ts`、`documents.ts` 的按需加载方式；新增类似能力避免进入首屏同步依赖链。

### NextUI 组件约定

通用交互控件优先使用现有封装，其次直接使用 `@nextui-org/react`。仅当工作台布局、编辑器、终端或特殊交互确有需要时自定义实现；无需把每个 NextUI 组件再包一层。

| 场景 | 优先使用 |
| --- | --- |
| 普通操作 | NextUI `Button`；图标按钮使用 `ui.tsx` 的 `IconButton` |
| 设置输入与多行输入 | `SettingControls.tsx` 的 `Field`、`TextField` |
| 设置选择、模型选择与开关 | `SelectField`、`ModelSelect`、`SettingSwitch` |
| 设置分组与切换 | `SettingRow`、`SettingSegments`、`SettingDisclosure`；其他业务按语义使用 NextUI Tabs / Accordion 或现有 Segmented |
| 对话框与危险操作确认 | NextUI `Modal` 组件族；通用危险操作复用 `ConfirmAction` |
| 提示、浮层与菜单 | NextUI `Tooltip`、`Popover`、`Dropdown`，已有专用业务菜单则复用 |
| 加载与远程状态 | `LoadingSkeleton`、`RemoteState` 或 NextUI `Spinner`，按页面形态选择 |

- `components/Motion.tsx` 的 `AppMotion` 已集中提供 `NextUIProvider`，统一处理动画、涟漪与系统减少动态效果偏好。业务页面不重复创建 Provider，不单独设置互相冲突的动效开关。
- 使用 NextUI 自身的状态与事件 API：按钮使用 `onPress`、`isDisabled`、`isLoading`；文本输入使用 `value` / `onValueChange`，开关使用 `isSelected` / `onValueChange`，选择器使用 `selectedKeys` / `onSelectionChange`。
- 受控组件以业务状态为唯一来源，不同时混用受控值与默认值；SelectItem 的 key 使用稳定业务标识，复杂显示内容提供 `textValue`，不使用数组下标代替身份。
- 新设置表单默认沿用 Field / SelectField 的外置标签、bordered 风格与尺寸；特殊紧凑布局通过现有 Props 和业务样式调整，不复制一套外观近似的控件。
- 通过 `className`、`classNames` 和组件公开 Props 定制样式。浮层通过 `popoverProps` 等公开入口设置，不依赖自动生成类名、DOM 层级或大范围 `!important` 覆盖。
- 弹窗沿用 `app-dialog` 相关样式及 ModalHeader / ModalBody / ModalFooter 结构，保留焦点管理、键盘关闭与滚动行为；异步提交时同步处理加载、重复操作和关闭限制。
- NextUI 浮层可能通过 Portal 挂到工作台节点之外，弹窗、Tooltip 和菜单样式不能只依赖局部容器祖先；验证主题、层级和滚动遮挡。
- `tailwind.config.js` 已接入 NextUI 插件与主题扫描，并处理 pnpm 的依赖布局；改动配置时保留这部分能力。调整主题色时同步检查 NextUI 主题映射与 `workspace-theme.css` 的语义变量。
- 新控件先核对项目已安装版本及相邻用法，避免引入与当前 NextUI API 不兼容的示例。组件库升级或更换单独安排，不随业务需求混入。

### TypeScript 与 React

- 使用函数组件与 Hooks，遵守 `web/tsconfig.json` 的 strict、未使用变量和参数检查。类型导入使用 `import type`。
- 新增 TS / TSX 代码沿用常见的两空格缩进、单引号和分号；配置、插件等文件遵循各自现有风格，不为统一风格批量重排旧代码。
- 组件文件使用 PascalCase，Hook 使用 `useXxx`，纯逻辑模块使用 kebab-case，函数和局部变量使用 camelCase。
- Props 与接口数据有明确类型；外部不可信数据先用 `unknown` 并校验，避免新增无约束 `any`、`@ts-ignore` 或强制断言绕过检查。
- 渲染保持纯净。可推导的数据直接推导；Effect 用于同步外部状态，不用多个 Effect 维护彼此可推导的状态副本。
- 异步请求、订阅和定时器在卸载或切换上下文时清理。切换服务、工作区、会话后，旧请求不得回写新视图，使用取消或请求身份校验。
- HTTP 调用优先复用 `LoopraClient`；SSE 复用既有解析与缓冲。页面组件不另写重复客户端或直接解析原始流。
- 可测试的归约、格式化、校验与状态转换放入独立逻辑模块；不要继续把无关逻辑堆入 `App.tsx`、`useLoopra.ts` 等大型文件。
- 后端拥有的会话与配置状态以服务端为准；草稿与纯 UI 偏好沿用现有本地存储封装和命名，避免新建冲突的缓存来源。

### 界面与样式

- 保持工作台的简洁布局。避免不必要的副标题、说明段落、重复状态标签和装饰性卡片，让分组、间距与对齐说明层级。
- 优先复用 `components/ui.tsx`、NextUI 控件和 Lucide 图标，保持按钮、弹窗、菜单、加载态与错误态一致。
- 颜色、背景、边框、圆角和阴影优先使用 `workspace-theme.css` 的语义变量；新增样式放入对应业务 CSS，避免无关全局选择器和覆盖链。
- 需要随界面缩放的字号和间距使用 `rem`，与 `--ui-scale` 协作；固定像素仅用于边线等明确场景。
- 新交互同时考虑亮色、暗色和窄窗口；滚动与面板缩放沿用现有布局机制。
- 图标按钮提供可读名称；表单有标签，键盘可操作，焦点可见。状态不能只靠颜色表达。
- 异步页面提供适当的加载、空数据、错误与重试状态；等待期间防止重复提交，失败保留可恢复的用户输入。
- 文案沿用页面现有中英文切换方式，面向用户说明动作和结果，不堆实现术语。`intro/` 的中英文文案同步维护。
- Markdown、HTML、外链和文件预览沿用已有消毒与协议检查，不绕过现有安全处理。

## 工具、插件与跨平台

- 新工具复用 `internal/service/tools` 注册机制，明确参数 schema、读写分类、审批和超时语义；毫秒超时参数沿用 `timeout_ms`。
- 路径处理复用 `fsutil` 和现有工具路径解析函数，考虑绝对路径、符号链接、尚不存在的文件及 Windows 路径。
- 保持 `toolsRestrictWorkspace` 的既有边界：它约束 `write` / `edit`；只读工具和 shell 的 `cwd` 不受该开关限制。审批策略另行处理，不混同为路径限制。
- 进程启动与终止复用 `shellenv`、`hideconsole`、`processtree` 等现有能力。超时和取消应清理所属进程树，避免只杀父进程或误杀其他会话。
- 平台差异放入 `*_windows.go`、`*_unix.go`、`*_other.go` 或明确的 build tags，通用业务代码不散布平台分支。
- 插件遵循 `docs/PLUGIN.md` 的入口和宿主 API。用户数据写入配置或数据目录，不写入更新时会被替换的插件包目录；更新失败保留旧运行时和数据。
- 打包目标以 `scripts/package-matrix.txt` 为准。修改发布流程时同步检查 PowerShell 与 shell 脚本，以及桌面和 Web 两种产物。
- 不提交运行数据、真实配置和密钥、`node_modules/`、`web/dist/`、`bin/`、缓存或临时可执行文件；仓库已跟踪的嵌入资源与许可证按既有流程维护。

## 开发与验证

工具链版本以 `go.mod` 和 `web/package.json` 的 `engines` 为准。前端依赖在 `web/` 使用 `pnpm install --frozen-lockfile` 安装；修改依赖时使用正常安装流程更新锁文件。

后端在仓库根目录运行：

```sh
go run ./cmd/looprax 4567
```

前端在 `web/` 运行 `pnpm dev`，地址为 `http://127.0.0.1:3000/`，`/api` 代理到 `127.0.0.1:4567`。使用启动日志中的访问密钥；开发或测试需要修改运行数据时，将 `LOOPRA_HOME` 指向临时目录，避免污染真实会话。

按变更范围执行检查，不为纯文档修改运行完整构建：

| 变更 | 验证 |
| --- | --- |
| Go 代码 | 对改动文件执行 `gofmt`，运行相关包测试；交付前运行 `go test ./...`、`go vet ./...`、`go build -o bin/looprax ./cmd/looprax` |
| 并发、取消、共享状态 | 补跑相关包的 `go test -race`；有支持的环境时与 CI 一致运行 `go test -race ./...` |
| 前端逻辑或组件 | 在 `web/` 运行相关测试、`pnpm test`、`pnpm build`；构建已包含 `pnpm typecheck` |
| 页面布局或交互 | 在构建检查外实际查看相关页面，验证亮暗主题、窄窗口、键盘与主要状态 |
| API、SSE、会话存储 | 运行对应契约回归，覆盖旧数据读取、流式消费或历史恢复等受影响链路 |
| 桌面入口或嵌入资源 | 先在 `web/` 运行 `pnpm build`，再从根目录构建对应 `-tags webdist` 入口 |
| `intro/` 脚本 | 在根目录运行 `node --test intro/release.test.cjs intro/mirrors.test.cjs`，文案和样式另做页面检查 |
| 纯文档 | 核对路径、命令和链接，运行 `git diff --check` |

默认 Go 构建不嵌入前端；只有前端构建完成后才能使用 `-tags webdist`。后端 CI 运行 `go test -race ./...`、`go vet ./...` 和 CLI 构建，并在 Windows、Linux、macOS 验证 ripgrep 与工具包。

外部插件集成测试通过 `LOOPRA_PLUGIN_SOURCE_DIR` 指向 `loopra-plugins` 源码目录，也支持仓库旁的同名目录。缺少可选夹具会跳过部分测试；交付时说明跳过情况。不要将临时夹具或外部仓库提交进项目。

测试要求：

- Go 使用 `*_test.go`、标准 `testing`、临时目录和测试清理；前端沿用 `web/tests/*.test.mjs`、`node:test`、`assert/strict`，按需使用现有 TypeScript 转译与 jsdom 方式。
- 行为变更与缺陷修复优先验证可观察结果和回归场景，避免只断言源码字符串或复制实现逻辑。
- 根据变更覆盖成功、失败、取消、并发及兼容边界。无需为纯文案或低风险样式改动新建机械测试。
- 默认测试不依赖个人配置、真实密钥、付费模型或外网；外部依赖用 fake、本地服务或明确的可选集成测试隔离。
- 检查失败时定位原因，不通过删除断言、批量改预期或跳过失败用例掩盖问题。环境不支持的检查如实记录，不报告为通过。

## 文档与交付

按改动主题查阅并更新相关文档，不复制整份契约到代码注释：

- 架构与依赖装配：[ARCHITECTURE.md](docs/ARCHITECTURE.md)、[SPRING_STYLE.md](docs/SPRING_STYLE.md)。
- API、SSE 与存储：[API_CONTRACT.md](docs/API_CONTRACT.md)、[SSE_AND_STORAGE_CONTRACT.md](docs/SSE_AND_STORAGE_CONTRACT.md)、[API_PARITY_AUDIT.md](docs/API_PARITY_AUDIT.md)。
- 工具与模型上下文：[TOOL_DISCOVERY.md](docs/TOOL_DISCOVERY.md)、[RG_TOOL.md](docs/RG_TOOL.md)、[CONTEXT_COMPACTION.md](docs/CONTEXT_COMPACTION.md)。
- 插件与启动方式：[PLUGIN.md](docs/PLUGIN.md)、[README.md](README.md)、[介绍页说明](intro/README.md)。

新增功能、配置或安装方式时同步面向用户的说明。修改 `intro/` 的 CSS / JS 并发布时，同步维护 HTML 中对应资源的版本参数。

交付前检查差异与 `git diff --check`，确认没有无关文件或敏感数据。提交信息沿用仓库的 `feat:`、`fix:`、`docs:`、`refactor:`、`test:` 等简短动词描述；除非用户要求，不自动提交、推送或发布。

交付说明写清改了什么、原因、实际执行的验证，以及仍有影响的限制；明确区分已通过、失败、跳过和未运行。

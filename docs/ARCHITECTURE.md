# 后端架构与开发指南

根模块使用 **GoFrame v2** 承载 HTTP（`ghttp`）、配置（`gcfg`）与日志（`glog`），
使用 `internal/spring` 这个 Go 版 IoC 容器组装依赖，使用 ADK Go 执行智能体。
`cmd/looprax` 是启动入口，应用实现收敛到 `internal`，避免业务包被其他 Go 模块意外依赖。

整体写法刻意贴近 Spring Boot：组合根声明 Bean、构造器注入、配置分层、
MVC 式路由、`ApplicationRunner` / `DisposableBean` 生命周期回调。
逐项对照与示例见[用 Java 的感觉写 Go](SPRING_STYLE.md)。

## 目录与职责

```text
cmd/looprax/main.go              命令行参数、退出信号
internal/
  bootstrap/
    application.go              @Configuration：Bean 注册清单与构造函数
    server.go                   ApplicationRunner / DisposableBean：监听、超时、优雅关闭
  spring/
    container.go                BeanFactory：构造器注入、单例缓存、生命周期、逆序销毁
    application.go              Application：@SpringBootApplication 的等价入口
  config/
    server.go                   进程设置：config.yaml、环境变量、命令行合并
  controller/
    router.go                   ghttp.Server、中间件顺序、404/405/500、静态托管
    mapping.go                  Spring MVC 风格路由注册器（apiRouter / readRoute）
    routes_*.go                 按模块注册路由
    config_controller.go        配置请求与响应
    sessions_controller.go      会话请求与响应
    files.go                    文件请求与响应
    runtime.go                  API 项目上下文、运行时缓存协调
    ...                         聊天、MCP、Git、任务等 API 模块
  service/
    config.go                   配置快照、并发更新、保存失败回滚
    file.go                     文件树、搜索、图片读取、删除
    workspace.go                工作区准备、Java 兼容工作区 ID
    agent/                      ADK 智能体组装与派生
    tools/                      内置工具及工具注册表
    hitl/                       人工审批规则与状态
    subagent/                   子智能体执行
    requirement/                需求存储、校验与执行调度
    schedule/                   定时任务存储、并发槽，以及 Cron 解析
    git/                        提交、暂存、差异与作者配置
    session/                    会话日志、审计镜像与 .meta 文件
    acp/                        外部 Agent 协议客户端，以及按会话复用的进程与轮次
    toolsearch/                 固定工具入口、MCP 定义检索、参数校验与动态调用
  repository/
    config.go                   config.json 读写
    jsonfile.go                 JSON 读取和原子文件替换
  model/
    config/                     持久化配置模型、默认值、兼容序列化
    file.go                     文件条目
    requirement.go              需求实体
    schedule.go                 定时任务与执行记录
  infrastructure/
    logging/                    glog 之上的带标签日志
    fsutil/                     路径解析、目录边界和符号链接检查
    gitops/                     Git 命令、工作树、快照
adk/
  model/                        模型协议适配与测试模型
  session/jsonl/                ADK 会话持久化适配器
manifest/config/config.yaml     application.yml 的等价物
```

`internal/config` 是进程的启动设置；`internal/model/config` 是与 Java `config.json`
兼容的业务配置模型。两者的生命周期和来源不同，分别管理。

Controller 按业务文件组织，共享进程级的会话和任务上下文。每个工作区在
`ProjectRuntime` 里只保留自己的智能体、工具和权限；请求进来时按工作区取出，
再套到这一次处理上。聊天、需求执行、MCP 等模块的 API 编排仍与该上下文协作；
可独立复用的操作、规则和持久化能力放在 Service、Repository 和基础设施中。

## 与 Java 开发方式的对应

| Java / Spring 概念 | 本项目的对应位置 |
| --- | --- |
| `Application.main` | `cmd/looprax/main.go` |
| `@SpringBootApplication` / `SpringApplication.run` | `bootstrap.Run` → `spring.NewApplication(...).Run(ctx)` |
| `@Configuration` / `@Bean` | `internal/bootstrap/application.go` 中的 `Bean(...)` 注册 |
| 构造器注入 | `NewConfigService(repository, initial)` 等普通 Go 函数 |
| `@Autowired` 字段注入 | 不支持；依赖必须由构造函数参数进入 |
| `@ComponentScan` | 显式注册清单，无运行时扫描 |
| `@ConfigurationProperties` / `application.yml` | `internal/config.Load` + `manifest/config/config.yaml` |
| `@RestController` / 请求映射 | `internal/controller` 与 `routes_*.go` |
| `@GetMapping` / `@PostMapping` | `readRoute`（GET+HEAD）/ `api.GET` / `api.POST` |
| `@PathVariable` | GoFrame 路由模式（`:id`）+ `request.SetPathValue` |
| `DispatcherServlet` | `controller.NewServer` 装配的 `ghttp.Server` |
| `@Service` | `internal/service` 及其业务子包 |
| Repository / DAO | `internal/repository` |
| Entity / DTO | `internal/model`；接口专用请求结构留在 Controller 附近 |
| `Filter` / `HandlerInterceptor` | `ghttp` 中间件与 `httpChain` 中的 `net/http` 过滤器 |
| `@ControllerAdvice` / 全局异常处理 | `BindStatusHandlerByMap` + `recoverHTTP` |
| `ApplicationRunner` | `httpServer.Run`（阻塞到进程退出） |
| `InitializingBean` / `DisposableBean` | `internal/spring` 的同名接口 |
| Bean 销毁回调 | 构造函数返回的 `func() error` + 逆序销毁 |

包名使用简短的小写名，例如 `service`、`repository`、`agent`。类型使用
`ConfigService`、`ConfigRepository`、`FileService` 等能体现职责的名称。
构造函数统一用 `NewXxx`；同一个包只公开一个入口对象时也可用 `New`，
例如 `agent.New`、`controller.New`。

Go 的结构体与方法承载实现；接口由使用方按实际需要定义。例如
`controller.ConfigService` / `controller.FileService` 只声明 HTTP 层真正用到的方法，
`service` 的实现自动满足该接口。不要求每个类型都配一组接口和 `Impl`。

## 依赖装配

应用的主要装配关系为：

```text
启动参数 / config.yaml -> config.Server -> ConfigRepository -> ConfigService
                                                          -> 工具注册表 -> Agent
ConfigService + FileService + Agent + 工具注册表 -> Controller
Controller -> ghttp.Server -> HTTP Server（ApplicationRunner）
```

全部 Bean 注册集中在 `bootstrap.Run`。构造函数通过参数声明依赖，容器按类型解析；
`context.Context` 自动注入。容器只出现在 `bootstrap`，Controller 和 Service
不从全局容器查找对象。

容器规则：

- 单例、按类型注入；重复的构造函数注册（或重复的实例注册）会在启动期以 `panic` 暴露；
  `Instance` 与 `Bean` 之间不做交叉查重，同类型实例优先、构造函数会被跳过；
- 接口解析优先复用唯一的预注册实例；否则要求构造函数定义唯一，多实现时应直接
  依赖具体类型，把选择留在组合根；
- 循环依赖立即报错；
- `DisposableBean.Destroy(ctx)` 与构造函数的 `func() error` 清理函数按创建顺序逆序执行，
  启动中途失败也会回滚已创建资源。

容器管理应用级对象。项目运行时、会话和单轮工具集按请求需要派生，并保留原有工作区
隔离方式；它们不注册成跨项目共用的单例。

MCP 使用固定的 `tool_search` / `call_tool` 两个入口。工具搜索和调用不会修改 Agent
的工具列表，命中的完整参数定义只出现在搜索结果中。MCP 连接在实际检索或调用时建立，
在当前轮次内复用，轮次结束后关闭。详见[工具发现与动态调用](TOOL_DISCOVERY.md)。

关闭时先中止智能体流和后台任务，再关闭 HTTP 服务与监听器。HTTP 没有配置整体写超时，
以支持 SSE。资源回收有一次性保护，启动中途失败也会释放已经构造的资源。

## 配置

进程级配置由 `internal/config.Load` 通过 `gcfg` 读取，优先级从高到低：

```text
命令行参数 / config.Options > 环境变量 > manifest/config/config.yaml > 内置默认值
```

配置文件路径：`config.Options.ConfigFile`（`--config`）优先于 `LOOPRA_CONFIG`，
两者都为空时使用 `manifest/config/config.yaml`；显式指定的文件缺失或无法解析会
启动失败，只有默认路径缺失时才使用内置默认值；相对路径按当前工作目录解析。
`gcfg` 同时支持 `.yaml/.yml/.toml/.json`。

业务配置（`internal/model/config`）默认读写 `<数据目录>/config.json`，
数据目录默认 `~/.loopra`，设置 `LOOPRA_HOME` 后随之迁移。

| 设置 | 来源与默认值 |
| --- | --- |
| 配置文件 | `--config` > `LOOPRA_CONFIG`，默认 `manifest/config/config.yaml` |
| 数据目录 | `LOOPRA_HOME` > `loopra.home`，默认 `~/.loopra` |
| 端口 | 命令行参数 > `LOOPRA_PORT` > `server.port`；未指定或为 `0` 时由系统分配空闲端口 |
| 监听地址 | `server.address`，默认 `127.0.0.1` |
| 访问密钥 | `LOOPRA_ACCESS_KEY` > `loopra.accessKey`，缺省时随机生成 |
| 前端目录 | `LOOPRA_STATIC_DIR` > `loopra.staticDir`；留空时用 `web/dist`，再是内嵌页面，最后才是 `<数据目录>/static` |
| 宠物目录 | `LOOPRA_PETS_DIR` > `loopra.petsDir`，默认 `~/.petdex/pets` |
| 读超时 | `server.readHeaderTimeout`，默认 10 秒；GoFrame v2.10 无头部超时，HTTP 读超时实际为 0（不限制请求体） |
| 空闲超时 | `server.idleTimeout`，默认 2 分钟 |
| 请求体上限 | `server.clientMaxBodySize`，默认 0（不限制） |
| 关闭等待时间 | `server.shutdownTimeout`，默认 10 秒 |
| 调试日志 | `LOOPRA_DEBUG=1`，默认关闭 |

## 请求链路

```text
请求
  -> requestLog          访问日志（默认记录 API 5xx 与除 401 外的 4xx）
  -> recoverHTTP         panic 恢复（@ControllerAdvice）
  -> cors                CORS；预检在鉴权前返回
  -> key.auth            访问密钥校验
  -> compatibilityHTTP   Java 兼容后端代理
  -> exportHTTP          MCP 导出端点
  -> routeGuard          API 方法不匹配 → 405 + Allow（基于 routeTable，先于静态兜底）
  -> scopeHTTP           工作区运行时上下文
  -> canonicalSlashRedirect  显式尾斜杠 301
  -> ghttp 路由           METHOD:/api/path
  -> Controller -> Service -> Repository / 基础设施
```

中间件通过 `ghttp.Server.Use` 注册，未匹配路由也会经过 CORS 与鉴权。
业务处理函数保持 `net/http` 形状，经 `s.action(...)` 适配为 `ghttp.HandlerFunc`；
路径参数在处理器入口由 `setRouterPathValues` 用 `Router.RegRule` / `Router.RegNames`
匹配 `URL.EscapedPath()` 后写入 `Request.PathValue`（单次解码），并保留 SSE 的刷新能力。

`routes_*.go` 显式保留 GET 对应的 HEAD 路由，以及原有子路径路由的末尾斜杠跳转。
未知 API 保持 404，非 API 的 GET / HEAD 仍支持静态资源与 SPA 回退。
`apiRouter` 把同一「方法 + 基路径」的精确、尾斜杠与通配处理器合并进 `routeEntry`，
`flush()` 只绑定一条 GoFrame 模式，由 `dispatch` 按原始 `RequestURI` 的尾斜杠分发；
`canonicalRedirect` 只登记无尾斜杠到有尾斜杠的 301 契约。

`apiRouter.flush()` 还会把注册时收集的 `routeTable` 挂到 `Controller.routes`；
`httpChain` 里的 `routeGuard` 用它区分 404/405（`entry.matches` 同时覆盖精确、
尾斜杠与 `/*` 通配），不再依赖 GoFrame 的 `RegRule` / `GetRoutes`。

## 阅读与扩展功能

建议先看两条完整链路：

1. 配置：`routes_config.go` → `config_controller.go` / `runtime.go` → `service/config.go`
   → `repository/config.go` → `model/config`。
2. 文件：`routes_files.go` → `files.go` → `service/file.go` → `model/file.go`
   / `infrastructure/fsutil`。

新增一个业务功能时：

1. 在 `model` 中定义需要复用或持久化的数据结构。
2. 在 `repository` 中实现存储；Service 需要替换实现时，在使用方定义小接口。
3. 在 `service` 中编写校验、业务操作及并发控制，使其能直接用普通 Go 测试调用。
4. 在 `controller` 中解析请求、取得工作区上下文、调用 Service、转换响应。
5. 在对应的 `routes_*.go` 注册路由；需要新的应用级依赖时，在
   `bootstrap/application.go` 的 `Bean(...)` 中注册构造函数。
6. 验证业务规则与 HTTP 行为。涉及聊天、权限、存储或路由时，运行原有 API 契约回归。

## 运行和验证

```bash
go test ./...
go vet ./...
go build ./cmd/looprax
go run ./cmd/looprax
```

测试和嵌入式调用可以通过 `bootstrap.Run(ctx, config.Options{...})` 指定隔离的
数据目录与端口。真实 HTTP 启停、鉴权、HEAD 与端口冲突由
`internal/bootstrap/application_test.go` 验证；构造器注入、循环依赖、Runner 阻塞与
逆序销毁由 `internal/spring/container_test.go` 覆盖；配置服务测试覆盖并发更新和
保存失败回滚。

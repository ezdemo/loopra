# 用 Java 的感觉写 Go：GoFrame + Spring 风格开发指南

本文面向从 Spring Boot 转到 Go 的开发者。LoopraX 的根模块刻意保留了 Spring 的心智模型：
**组合根集中声明 Bean、构造器注入、配置分层、MVC 式路由、应用生命周期回调**，
但底层换成 Go 生态的 [GoFrame v2](https://goframe.org/)（`ghttp` / `gcfg` / `glog`）
与 [ADK Go](https://google.github.io/adk-docs/) 智能体运行时。

目标不是把 Go 写成 Java，而是**让 Spring 开发者读代码时不需要换脑子**：

- 依赖关系集中在 `internal/bootstrap`，业务包不查全局容器；
- 装配用普通函数表达，编译期就能发现类型错误；
- 约定优于配置，但不依赖注解扫描和运行时代理。

## 1. 概念对照表

| Spring Boot | LoopraX 对应物 | 位置 |
| --- | --- | --- |
| `@SpringBootApplication` / `SpringApplication.run` | `spring.NewApplication("looprax").Run(ctx)` | `cmd/looprax/main.go` → `bootstrap.Run` |
| IoC 容器 / `ApplicationContext` | `internal/spring`（`Application` + `BeanFactory`） | `internal/spring/` |
| `@Configuration` + `@Bean` | `app.Bean(构造函数…)` | `internal/bootstrap/application.go` |
| 构造器注入 | 构造函数参数按类型解析 | 全部 `NewXxx` 函数 |
| `@Autowired` 字段/Setter 注入 | **不支持**，依赖必须从构造函数进入 | — |
| `@ComponentScan` | **显式注册**（注册清单就是扫描结果） | `bootstrap.Run` 的 `Bean(...)` |
| `@Service` | `internal/service` 及其子包 | `internal/service/` |
| Repository / DAO | `internal/repository` + `infrastructure` | `internal/repository/` |
| `@ConfigurationProperties` / `application.yml` | `config.Load` + `gcfg` 读取 `manifest/config/config.yaml` | `internal/config/server.go` |
| `@RestController` / `@RequestMapping` | `apiRouter` + `routes_*.go` 的路由模块 | `internal/controller/` |
| `@GetMapping` / `@PostMapping` / `@DeleteMapping` | `readRoute` / `api.GET` / `api.POST` / `api.DELETE` | `internal/controller/mapping.go` |
| `@PathVariable` / `@RequestParam` | GoFrame 路由模式 + `PathValue` / `URL.Query()` | `controller/router.go` 的 `action` / `setRouterPathValues` |
| `DispatcherServlet` | `ghttp.Server`（`controller.NewServer` 装配） | `internal/controller/router.go` |
| `Filter` / `HandlerInterceptor` | `ghttp` 中间件 + `httpChain` 内的 `net/http` 过滤器链 | `controller/router.go` |
| `@ControllerAdvice` / `@ExceptionHandler` | `BindStatusHandlerByMap` + `recoverHTTP` | `controller/router.go` |
| `ApplicationRunner` / `CommandLineRunner` | `spring.ApplicationRunner`（`httpServer.Run`） | `internal/bootstrap/server.go` |
| `InitializingBean` / `DisposableBean` | `spring.InitializingBean` / `spring.DisposableBean` | `internal/spring/container.go` |
| Actuator `/actuator/health` | `GET /api/system/health` | `controller/router.go` |
| CORS 配置 | `cors` 中间件 | `internal/controller/cors.go` |

## 2. 组合根：像写 `@Configuration` 一样写 `bootstrap`

`internal/bootstrap/application.go` 是唯一知道“有哪些实现、谁依赖谁”的地方：

```go
func Run(ctx context.Context, options config.Options) error {
	return spring.NewApplication("looprax").
		Instance(options).                     // 预先构造的单例（等价于提前 new 好的 Bean）
		Bean(
			config.Load,         // @ConfigurationProperties
			newConfigRepository, // @Repository
			newConfigService,    // @Service
			service.NewFileService,
			newToolRegistry,
			newAgent,
			newBackend,
			newRouter,
			newHTTPServer,       // ApplicationRunner：阻塞到进程退出
		).
		Run(ctx)
}
```

容器支持的构造函数签名（与 Spring 的 `@Bean` 方法对应）：

```go
func newThing(dep *Dep) *Thing                                  // 等价于 @Bean Thing thing(Dep dep)
func newThing(dep *Dep) (*Thing, error)                         // 构造失败可回滚
func newThing(dep *Dep) (*Thing, func() error, error)           // 附带清理函数
```

规则：

- **按类型注入**。`context.Context` 默认由容器自动传入（`BeanFactory.SetContext`）；
  若显式注册了 `context` 实例，则优先使用该实例。其余参数从已注册的单例中解析，
  必要时递归创建。
- **一个具体类型只能有一个 Bean**。重复的构造函数注册（或重复的实例注册）会在
  启动时通过 `panic` 暴露，而不是返回 error。这是有意的：Go 没有 `@Qualifier`，
  同名多实例应该用不同的包装类型或显式工厂表达。
  注意 `Instance` 与 `Bean` 之间**不做交叉查重**：同类型实例已被预注册时，
  对应构造函数会被跳过；组合根应避免同时登记同一具体类型。
- **接口解析要求唯一实现**。若恰好有一个预注册实例实现了该接口，会优先复用它；
  否则在构造函数定义中要求唯一匹配。无预注册实例且存在多个实现时会报错，
  此时请直接依赖具体类型，把选择放回组合根。
- **循环依赖直接报错**（`spring: circular dependency on …`），不要用字段注入绕过。
- **销毁顺序是创建顺序的逆序**：先执行 `DisposableBean.Destroy(ctx)`，
  再执行构造函数返回的 `func() error` 清理函数；启动中途失败同样会回滚。

业务代码不要出现 `app.Context().Get(...)` 之类的服务定位器调用；
容器只出现在 `internal/bootstrap`。测试里直接 `new` 出被测对象并传入 fake 即可，
这与 Spring 测试里手动 `new Service(mockRepo)` 的思路一致。

## 3. 配置：`application.yml` 的 Go 版本

进程级配置由 `internal/config.Load` 通过 GoFrame `gcfg` 读取，优先级从高到低：

```text
命令行参数 / config.Options
  > 环境变量
  > manifest/config/config.yaml（可用 LOOPRA_CONFIG 指向其他文件）
  > 内置默认值
```

示例 `manifest/config/config.yaml`：

```yaml
server:
  address: "127.0.0.1"
  port: 0          # 0 或不写：系统分配空闲端口
  readHeaderTimeout: 10s
  idleTimeout: 2m
  shutdownTimeout: 10s
  clientMaxBodySize: 0

loopra:
  home: ""          # 留空使用 ~/.loopra
  accessKey: ""     # 留空时启动日志中自动生成
  staticDir: ""     # 留空使用自行编译的 web/dist
  petsDir: ""       # 留空使用 ~/.petdex/pets
```

对应环境变量：`LOOPRA_HOME`、`LOOPRA_PORT`、`LOOPRA_ACCESS_KEY`、
`LOOPRA_STATIC_DIR`、`LOOPRA_PETS_DIR`、`LOOPRA_CONFIG`、`LOOPRA_DEBUG`。
`gcfg` 同时支持 `.yaml/.yml/.toml/.json`，因此迁移 Spring 配置时不必改写格式。

配置文件路径：`config.Options.ConfigFile`（对应 `--config`）优先于
`LOOPRA_CONFIG`，都为空时使用 `manifest/config/config.yaml`。**显式指定**的
文件缺失或无法解析会启动失败（避免静默用默认值）；只有默认路径缺失时才使用
内置默认值。相对路径按当前工作目录解析。

注意区分两套配置：

| 配置 | 来源 | 生命周期 |
| --- | --- | --- |
| `internal/config.Server` | 命令行、环境变量、`manifest/config/config.yaml` | 进程启动设置，只读 |
| `internal/model/config.Loopra` | 默认 `<数据目录>/config.json`（数据目录默认 `~/.loopra`） | 业务配置，运行期可更新并持久化 |

## 4. HTTP 层：Spring MVC 的味道

### 4.1 装配与中间件

`controller.NewServer` 负责创建 `ghttp.Server`、注册中间件与 404/500 状态处理器，
最后调用 `RegisterRoutes`；空闲超时与优雅关闭超时由 `bootstrap.newHTTPServer`
在拿到 server 后设置。GoFrame v2.10 只提供覆盖整个请求体的 `SetReadTimeout`，
没有 `ReadHeaderTimeout`，因此读超时保持 0（不限制），避免大文件上传被截断。

```text
requestLog          访问日志（默认记录 API 5xx 与除 401 外的 4xx；401 轮询、成功请求与静态资源仅调试模式）
httpChain           net/http 过滤器链：
  recoverHTTP         panic → 500（等价于 @ControllerAdvice）
  cors                CORS（预检在鉴权之前返回）
  key.auth            访问密钥校验
  compatibilityHTTP   Java 后端代理
  exportHTTP          MCP 导出端点
  routeGuard          405 方法判定（基于 apiRouter 的 routeTable，先于静态兜底与业务处理器）
  scopeHTTP           工作区运行时上下文
canonicalSlashRedirect  保留 Java API 的尾斜杠 301 契约
```

未匹配的路由也会经过中间件；404/500 由 `BindStatusHandlerByMap` 统一处理。
405 由 `apiRouter` 注册时收集的 `routeTable` 在分发前判定并回填 `Allow`；
静态兜底（`/`、`/*`）不参与，因此不存在的路径仍然是 404。

SSE 依赖 GoFrame 的原始写入器：服务不设置整体写超时，`responseRecorder`
保留 `Flush`，聊天流可以持续输出。

### 4.2 路由模块 = Controller 的 `@RequestMapping`

每个业务模块一个 `routes_*.go`，由 `Controller.RegisterRoutes` 统一挂载：

```go
func (s *Controller) registerFilesRoutes(api *apiRouter) {
	readRoute(api, "/files/tree", s.action((*Controller).filesController))
	readRoute(api, "/files/image", s.action((*Controller).filesDeepController))
	api.POST("/files/paste", s.action((*Controller).filesController))
	api.DELETE("/snapshots/:msgId", s.action((*Controller).snapshotDelete))

	// 与 Java 版一致的尾斜杠 301 契约
	s.canonicalRedirect("GET", "/api/git")
}
```

- `readRoute` 是 `@GetMapping` 的等价物：一次声明同时注册 GET 与 HEAD。
- `api.Group("/admin")` 等价于 `@RequestMapping("/admin")` 前缀分组。
- 注册分两阶段：`bind` 先把同一「方法 + 基路径」的精确、尾斜杠与通配处理器
  收集进 `routeEntry`；`RegisterRoutes` 末尾的 `api.flush()` 才为每个条目绑定
  一条 GoFrame 模式（存在通配处理器时绑定 `METHOD:/api/base/*`）。
- 合并绑定是必要的：GoFrame 会把 `/pets` 与 `/pets/` 归一为同一模式，而且
  `/x/*` 的匹配优先级高于 `/x`；若分开注册，精确请求会错误命中通配处理器。
  `routeEntry.dispatch` 根据原始 `RequestURI` 是否带尾斜杠，在精确、斜杠、
  通配处理器之间选择。
- 同一类别的处理器后注册会覆盖先注册，同一个路由模块里不要重复声明同一路径。
- `canonicalRedirect` 只登记「无尾斜杠 → 有尾斜杠」的 301 契约；真正服务
  `/x/` 请求的是 `routeEntry` 里的 slash 处理器。

### 4.3 Handler 仍然是 `net/http` 形状

Controller 方法保持 `func(*Controller, http.ResponseWriter, *http.Request)`，
由 `s.action(...)` 适配成 `ghttp.HandlerFunc`。路径参数在处理器入口由
`setRouterPathValues` 还原：用 GoFrame 的 `Router.RegRule` / `Router.RegNames`
匹配 `URL.EscapedPath()`，再写入 `request.SetPathValue`，保证 `%252F` 这类转义
只解码一次。这样做的好处是业务处理与 Web 框架解耦，已有测试和 SSE 写法不需要改写。

## 5. 分层与依赖方向

```text
controller  →  service  →  repository / infrastructure
     │             │
     └─────────────┴────→ model（纯数据结构）
```

- `controller` 只做请求解析、工作区上下文、调用 Service、响应转换；
- `service` 承载业务规则、并发控制与编排，是不依赖 HTTP 的普通结构体；
- `repository` 负责持久化（JSON 文件、原子替换）；
- `infrastructure` 放 Git、进程、ripgrep、路径校验等外部能力；
- 接口由**使用方**定义。例如 `controller` 包内的 `ConfigService` / `FileService`
  只声明 HTTP 层真正需要的方法，`service` 的实现自动满足，不需要 `Impl` 后缀。

与 Spring 单例一样，注册进容器的 Bean 必须并发安全。
项目运行时、会话、单轮工具集等按请求派生的对象**不要**注册成单例，
它们各自有明确的所有者和关闭路径。

## 6. 生命周期：Runner 与销毁回调

`httpServer` 同时扮演两个 Spring 角色：

```go
// ApplicationRunner：容器刷新完成后启动 ghttp，阻塞到 ctx 取消或服务器意外停止
func (s *httpServer) Run(ctx context.Context) error { /* ... */ }

// DisposableBean：逆序销毁时优雅关闭
func (s *httpServer) Destroy(context.Context) error { return s.close() }
```

关闭顺序是：取消智能体流与后台任务 → 关闭 HTTP 服务 → 关闭监听器。
`backend` 也实现 `DisposableBean`，重复关闭由 `sync.Once` 保护。
启动失败（例如端口被占用）时，容器会回滚已经创建的 Bean，不会泄漏监听器或子进程。

## 7. 和 Spring 不一样的地方（刻意为之）

1. **没有注解和包扫描**。注册清单是显式代码，IDE 可跳转、编译期可检查，
   也不会出现“改了包名忘记扫描”的运行时惊喜。
2. **没有字段注入、没有 AOP 代理**。横切逻辑用中间件或装饰函数显式包裹；
   `@Transactional` 式隐式代理不在当前设计中，事务边界应写在 Service 内。
3. **错误是返回值，不是异常**。`recoverHTTP` 只兜住 panic；
   业务错误通过 `error` 返回并由 handler 转成响应。
4. **接口很小，按需定义**。不要求“一个类型配一个接口”，也不追求 `Impl` 命名。
5. **容器能力有限且明确**：按类型、单例、构造器注入、生命周期回调；
   没有 `@Qualifier`、`@Scope("prototype")`、`@Lazy`。需要多实例时用工厂函数
   返回不同的包装类型，或把“每次创建”留在业务代码里。
6. **GoFrame 的路由归一化**：`/x` 与 `/x/` 是同一模式，需要保留 Java 的
   尾斜杠重定向时必须显式登记。

## 8. 新增一个功能的推荐顺序

1. `model`：定义需要复用或持久化的结构。
2. `repository`：实现存储；Service 侧按需定义小接口。
3. `service`：写业务规则与并发控制，用普通 Go 测试覆盖。
4. `controller`：解析请求、取工作区上下文、调用 Service、写响应。
5. `routes_*.go`：注册路由；需要新的应用级依赖时，在 `bootstrap.Run` 的
   `Bean(...)` 里加一行构造函数。
6. 运行 `go test ./...`、`go vet ./...`；涉及聊天、权限、存储或路由时，
   补跑对应 API 契约回归。

## 9. 验证

```bash
go test ./...
go vet ./...
go build ./cmd/looprax
go run ./cmd/looprax
```

真实 HTTP 启停、鉴权、HEAD 与端口冲突由 `internal/bootstrap/application_test.go` 覆盖；
容器的注入、循环依赖、Runner 阻塞与逆序销毁由 `internal/spring/container_test.go` 覆盖。

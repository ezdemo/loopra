# Loopra Mobile 与加密中继协议

`mobile/` 是 Tauri v2 + React 移动端，独立实现手机布局、导航、输入和会话状态，复用 `LoopraClient`、事件归约、历史转换和 `Conversation` / `BlockRenderer` 核心聊天渲染，不挂载桌面 `App.tsx`。扫码连接后，手机将该桌面的虚拟 origin 请求送入加密隧道，桌面交给已经初始化的 GoFrame 路由处理。HTTP JSON、二进制和 SSE 不转换业务格式。

alma-relay 只负责转发不透明数据，不使用 Alma 客户端、线程模型或业务 API。旧 `alma://` 配对和 `/__alma_e2e__` 入口不再接受。

## 桌面配置与配对

进入「设置 → 连接与帮助 → 远程访问」，填写自建 alma-relay 的 HTTPS origin。中继未启用注册认证时，注册密钥留空；已保存密钥需要点击清除按钮后保存才能删除。保存后立即重连，失败保留旧配置。页面只展示 Loopra Mobile 的链接和 PNG 二维码。

环境变量 `LOOPRA_ALMA_RELAY_URL`、`LOOPRA_ALMA_RELAY_KEY` 提供尚未在页面保存时的默认值。默认禁用。为保留已使用的中继配置，持久化文件继续使用 `<LOOPRA_HOME>/alma-relay.json`，包含 `enabled`、`relayUrl`、`registrationKey` 和 `connectCode`，保留未知字段并原子更新。注册密钥不返回给前端或手机。

`connected` /「中继已连接」只代表桌面注册成功。手机还需要能建立 WSS 连接；能打开 `/healthz` 不能证明加密隧道可达。公网中继必须具备有效 HTTPS 证书。若手机无法访问 workers.dev，可为 Worker 配置自定义域名。

配对链接：

```text
loopra://connect?e2e=1&v=1&k=<32-byte-base64url-secret>&u=<https-origin>
```

配对码是远程工作台的访问凭据，仅交给信任的设备。重置配对会断开所有旧手机，使旧二维码失效，但不会取消正在执行的 Agent。停用保留设置和配对身份。

## 管理 API

以下接口使用普通 `X-Loopra-Key`、`{success,data?,error?,reason?}` 和 `Cache-Control: no-store`：

| 方法与路径 | 契约 |
| --- | --- |
| GET / HEAD `/api/remote/relay` | `{enabled,state,relayUrl?,hasRegistrationKey,pairingLink?,qrCode?}`；禁用时省略链接与二维码。 |
| PUT `/api/remote/relay` | `{enabled?,relayUrl?,registrationKey?}`；省略密钥表示保留，空字符串清除；先保存，再替换连接。 |
| POST `/api/remote/relay/reset-pairing` | 原子生成新随机身份并重连，返回同样的状态结构。 |
| GET / HEAD `/api/mobile/handshake` | `{protocol:"loopra-relay",version:1,serverVersion,capabilities:["http","sse","binary"]}`，仍使用普通响应包装。 |

管理 API 拒绝未知字段、多段 JSON、超长地址和无效身份；只读端点沿用 HEAD、405/Allow 与尾斜杠契约。

## 协议 v1

桌面连接中继 `/agent?th=<sha256(routingId)>`，协商外层 relay protocol 1。手机连接 `/c/<routingId>/__loopra_e2e__/v1`。这两个版本相互独立。所有未加密 HTTP 请求返回 403；未知隧道路径被拒绝。

加密标签为 `loopra-relay-e2e/v1`。`routingId` 是 `HKDF-SHA256(UTF8(connectCode), UTF8(label + "/routing"), empty-info, 16)` 的 base64url 编码。握手为 ECDH-P256 的 `hi → hi → ok`，携带临时未压缩公钥、16 字节 nonce，以及双方 HKDF 确认值。会话密钥与确认值由共享秘密、配对码和握手 transcript 导出。原生手机实现在 `mobile/src-tauri/relay-core/src/crypto.rs`，浏览器预览实现在 `mobile/src/relay/crypto.ts`，桌面实现在 `internal/service/almarelay/crypto.go`；三者保持同一 v1 协议。

密文为 `12-byte IV || AES-256-GCM ciphertext-and-tag`。IV 为四个零字节加八字节大端计数器，每个方向从零独立递增；严格拒绝重放、乱序、篡改和未完成认证的消息。v1 只协商 JSON 内层帧。

| 帧 | 内容 |
| --- | --- |
| `hreq` | `id,method,path,headers?,b?`；path 为 `/api/` 下的相对目标；b 是请求体的无填充 base64url。 |
| `hres` | `id,status,headers`，先于任何响应体。 |
| `hchunk` | `id,b`，逐块原样传递响应字节，单块最大 64 KiB。 |
| `hend` | `id`，响应正常结束。 |
| `herr` | `id,message`，请求或响应失败；已打开的响应流报错。 |
| `hcancel` | `id`，取消对应 HTTP 读取；不等同于 `/api/chat/abort`。 |

每个设备最多 64 个并行请求，原生手机为健康检查保留一个名额；最多 32 个设备。请求体最大 6 MiB，普通响应最大 16 MiB，单个 SSE 响应累计最大 256 MiB。手机缓冲超过 8 MiB 后取消读取。握手期限 25 秒（桌面在收到隧道连接后等待 15 秒）。响应头只传递内容、缓存、Range、Location 和 Allow；不转发访问密钥、Cookie 或任意 Host。

桌面通过进程内 HTTP writer 转发响应，`HEAD` 仍可能包含 `hchunk`；原生健康检查必须在成功的 `hres` 后校验并消费这些帧，直到 `hend`，内容累计上限 64 KiB。不能把 HEAD 内容帧误判为隧道失效，否则每次心跳都会主动断开健康连接。无内容的 HEAD 响应同样兼容。

认证后的手机拥有工作台 API 权限。桌面在内存中注入本机访问密钥后，仍走原路由、公共鉴权、工作区隔离与审批策略；本机访问密钥不发送给手机。手机使用每个配对独立的虚拟 origin，切换设备时卸载旧传输；断线使在途读取失败，不自动重放写操作。

聊天处理器由应用拥有，断线时解除手机等待，后台轮次继续，重连后从现有历史与执行状态恢复。关闭应用先停止接收与断开中继，再取消 Agent 并等待原生处理器退出，避免未完成轮次阻塞中继关闭。

## 移动应用

构建和系统依赖见 [mobile/README.md](../mobile/README.md)。Tauri 的 Rust `loopra-relay` 核心拥有 WebSocket、双向认证、加解密与计数器、HTTP 请求分发、取消、响应缓冲和自动重连。TLS 使用 rustls / WebPKI 验证证书，不开放任意原生网络请求入口。TS 的 `relay/native.ts` 只将原生请求适配成 `Response` / `ReadableStream`，继续复用 `LoopraClient`、SSE 解析和聊天渲染。连接状态通过 Tauri Channel 通知；响应正文通过原始二进制 IPC 按需读取，每块最多 64 KiB，原生端所有请求的未读取正文合计最多 8 MiB，前端流预取最多 64 KiB。超限只取消对应读取，避免 WebView 暂停时无限积压。

Android 扫码走随包内置的 ZXing 扫描 Activity，iOS 使用原生扫码插件。浏览器预览保留 TS 加密传输和浏览器 WebSocket，并提供粘贴链接。配对保存在原生应用私有目录，Unix 权限 0600；浏览器预览使用自身 localStorage。不会保存桌面 Web 访问密钥或中继注册密钥。

手机界面位于 `mobile/src/MobileWorkspace.tsx`，会话状态由 `session-store.ts` 拥有。液态玻璃风格的应用面板、项目网格、会话分组、悬浮底栏和触控动效由现有 NextUI / Framer Motion 与手机 CSS 实现；不是引入 Compose 原生组件。正文保留 Loopra 渲染，会话列表复用桌面 `AgentIcon` 按 `agentId` 展示 Agent 图标；界面基准比例为 93.5%（原大小的 110%），字号独立设置为 15 / 16 / 18px，并同步调整根字号，思考与工具默认折叠；不支持双指缩放界面。底部 sheet 的抓手可按压、跟手上下拖动并按速度或距离关闭。长按选择仅对会话正文与编辑控件开放，其他界面和 context menu 被禁用。减少动态效果遵从系统，玻璃效果在减少透明效果或不支持 backdrop-filter 时回退到实体背景。

手机通过原接口加载项目、会话、历史、模型与引擎目录，发送流式聊天、带 requestId 的停止请求、权限审批和 Agent 提问答案。当前会话运行中发送的新消息按会话进入 FIFO 队列，可编辑、撤回或提升为下一条；回复正常结束、用户停止后均等待后台执行状态变为空闲，再自动发送队首消息。历史刷新或网络失败时保留未发送项，不跨会话串队。回复设置通过 `/api/agent-engines/config` 读取实际值，不显示固定占位项；新会话先通过 `/api/agent-engines/prepare` 获取该 Agent 的配置和草稿会话，发送时复用同一会话。模型、思考强度、权限模式、布尔开关及 ACP 自定义 `configOptions` 都可在手机端展开修改，流内 `config_options` 事件会同步更新界面。切换会话不取消流；断流后轮询执行状态并恢复历史、审批和提问。每个流只更新所属会话，旧读取不回写新选择。向上阅读时暂停自动跟随，点击「回到最新」恢复。连接断开后不会重放写请求。

重新连接复用当前 `MobileWorkspace` 与 `.loopra.invalid` origin，因此不会回到配对页或丢失当前页面、会话状态与排队消息。原生端保留同一个 TS 适配器，由 Rust 在 0.9 / 2.2 / 5 / 10 / 30 秒退避后持续重试；首次连接时桌面离线也能恢复，等待期间可取消连接。每次重连都建立新的临时密钥，并验证 `/api/mobile/handshake`；身份认证失败或明确的协议不兼容停止重试。每 20 秒发送 WebSocket Ping，并通过加密隧道发送 `HEAD /api/mobile/handshake` 检查桌面；桌面 10 秒未响应或连接 60 秒未收到帧时重连，不能只凭中继的 Pong 判断桌面在线。Tauri `RunEvent::Resumed` 只触发健康检查，健康的连接和 SSE 不会因切回前台而被主动断开。Rust 缓存带递增 revision 的连接状态；WebView 暂停时 Channel 通知失败不结束连接，前台通过 `relay_status` 同步快照并忽略迟到状态。

Android 在用户连接桌面时启动同进程的 `remoteMessaging` 前台服务，以低优先级常驻通知维持后台消息连接。通知只显示「正在保持桌面连接」，不包含配对码或对话内容；Android 13+ 首次连接请求通知权限，拒绝只影响通知展示，不阻止连接。服务通过原生 Tauri 插件与 Rust 连接生命周期绑定，不依赖 JS 的 onPause / 定时器；切换实例时校验连接身份，旧关闭事件不能停止新服务。取消连接、认证终止、移除配对、根页面退出或移除最近任务时停止服务；服务使用 `START_NOT_STICKY`，不在开机或进程死亡后自行拉起。没有申请省电白名单或常驻唤醒锁；深度 Doze、厂商省电策略、网络切换和系统强制停止仍可能中断网络。iOS 不使用此 Android 服务。断线令所有在途读取失败，旧连接排队的写请求不会在新连接重放，恢复后从历史与执行状态同步。

浏览器预览继续使用页面可见性和有限次数的 TS 退避恢复。连接管理页把实例名称作为本地配对元数据随配对一起持久化；修改名称不重启连接，重新配对或移除连接才改变当前配对。Android `MainActivity` 暴露仅控制状态栏、导航栏明暗、扫码 Activity 和前台恢复事件的 JS bridge；页面主题或系统主题变化时同步图标颜色，系统返回键先交给页面关闭弹层、管理页或聊天页，仅在根页面才退出应用。

自动重连期间，当前页面顶部持续显示「正在重新连接…」和旋转图标，原生端退避等待时也保留提示。手动「立即重试」唤醒同一条原生连接，合并重复点击，并等待健康检查或新连接确认后解除按钮等待；35 秒仍未恢复时结束本次手动等待，原生自动重连继续。恢复成功短暂显示「连接已恢复」，健康连接手动检查显示「连接正常」；保留当前会话、阅读位置和草稿，并自动刷新项目、会话、配置和选中会话的执行状态。断线期间隐藏列表、聊天中的重复读取错误，避免多个重试入口同时争抢连接；连接管理页仍可在自动退避时切换或移除实例。

### 液态玻璃底栏

底栏使用 CSS `backdrop-filter`，把背景模糊、半透明中性色、圆角裁剪与边缘高光放在同一个表面上。移除原先的 `liquid-glass-react` SVG 折射层：该层与背景模糊叠加时，在 Android WebView 真机上出现灰色矩形，底下项目文字也未经充分模糊直接透出。当前背景模糊为 `1.5rem`，并用中性底色维持导航文字的对比度；不模拟光学折射。标签、图标、选中态和触控区域保持清晰，由 `mobile.css` 的应用语义变量控制。选中框可跟手横向拖动，拖动中可随时停住，松手后吸附到最近的会话或项目页。

会话与项目列表、聊天容器、输入框和底部 sheet 使用 CSS `backdrop-filter` 做克制的分组玻璃，而不为每个内容块挂载 SVG 滤镜。减少动态效果关闭弹簧回弹和按压变形；减少透明效果、不支持背景模糊或低端 WebView 回退到实体表面。这个实现不承诺与 iOS 系统材质逐像素一致，实际性能与效果仍依赖手机 WebView 和 GPU。

当前不提供交互式终端、插件 iframe、完整编辑器、历史回滚、系统文件对话框与桌面窗口桥接；外部 Agent 的配置列表与桌面共用同一套 ACP 数据。iOS 需要 macOS/Xcode；相机权限、系统安全区和软键盘仍需真机验收。

## 验证

默认 Go 测试不依赖外网和个人配置。`mobile/pnpm test` 覆盖配对校验、双向认证、并行请求、SSE、取消、断线、篡改、虚拟 origin 隔离及手机会话的导航隔离、前台恢复通知、精确停止、历史恢复、审批、提问、消息排队与 Agent 配置读写。`mobile/tests/ui-fixture.html` 只供开发预览，不进入应用产物。

在 `mobile/src-tauri/` 运行 `cargo test -p loopra-relay` 验证 Rust 核心；测试使用 `mobile/` 已安装的 Node / ws 和独立 WebCrypto 响应端，不调用外网或模型，覆盖真实 WebSocket 的双向认证、二进制与 SSE、并行分发、取消、首次离线恢复、健康连接前台恢复不中断、WebView 通知失败仍保持连接、中继 Pong 与桌面失活分离，以及缓冲上限、健康检查名额、重放与篡改拒绝。`mobile/pnpm test` 同时验证原生 IPC 到 fetch 的薄适配、状态快照乱序、关闭竞态和写请求不重放。`cargo check -p loopra-mobile` 检查 Tauri 壳层。Android 工程的 `:app:testArm64DebugUnitTest` 验证前台服务的连接身份与迟到回调隔离；服务生命周期、权限弹窗与深度待机仍需真机验收。

真实桌面互操作回归：在仓库根目录用 `go build -o .cache/mobile-native-desktop-fixture.exe ./mobile/tests/native-relay-desktop.go` 编译测试进程，把 `LOOPRA_NATIVE_DESKTOP_FIXTURE` 设为该可执行文件的绝对路径，再在 `mobile/src-tauri/` 运行 `cargo test -p loopra-relay production_desktop_health_checks_do_not_cycle_the_connection -- --ignored --nocapture`。该用例通过本地中继连接生产 Go relay、加密隧道和 HTTP 路由，连续手动检查并跨越两次周期心跳，断言连接 revision 不变；临时用户目录与真实配置隔离。默认 Node 响应端也模拟桌面 HEAD 内容帧，避免默认测试遗漏此回归。

可选真实互操作测试需要 `web/` 与 `mobile/` 已安装依赖，以及独立的 alma-relay checkout：

```powershell
# 在 alma-relay checkout 先执行 npm ci --ignore-scripts。
$env:LOOPRA_MOBILE_INTEROP = '1'
$env:LOOPRA_ALMA_RELAY_SOURCE = 'C:\path\to\alma-relay'
go test ./internal/controller -run TestLoopraMobileInteroperability -v -count=1 -timeout 60s
```

互操作使用真正的移动传输和未经改写的 `LoopraClient`，模型为本地脚本，所有会话位于测试临时目录，不调用付费模型。

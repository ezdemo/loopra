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

加密标签为 `loopra-relay-e2e/v1`。`routingId` 是 `HKDF-SHA256(UTF8(connectCode), UTF8(label + "/routing"), empty-info, 16)` 的 base64url 编码。握手为 ECDH-P256 的 `hi → hi → ok`，携带临时未压缩公钥、16 字节 nonce，以及双方 HKDF 确认值。会话密钥与确认值由共享秘密、配对码和握手 transcript 导出。`mobile/src/relay/crypto.ts` 和 `internal/service/almarelay/crypto.go` 是两端实现。

密文为 `12-byte IV || AES-256-GCM ciphertext-and-tag`。IV 为四个零字节加八字节大端计数器，每个方向从零独立递增；严格拒绝重放、乱序、篡改和未完成认证的消息。v1 只协商 JSON 内层帧。

| 帧 | 内容 |
| --- | --- |
| `hreq` | `id,method,path,headers?,b?`；path 为 `/api/` 下的相对目标；b 是请求体的无填充 base64url。 |
| `hres` | `id,status,headers`，先于任何响应体。 |
| `hchunk` | `id,b`，逐块原样传递响应字节，单块最大 64 KiB。 |
| `hend` | `id`，响应正常结束。 |
| `herr` | `id,message`，请求或响应失败；已打开的响应流报错。 |
| `hcancel` | `id`，取消对应 HTTP 读取；不等同于 `/api/chat/abort`。 |

每个设备最多 64 个并行请求，最多 32 个设备；请求体最大 6 MiB，普通响应最大 16 MiB，单个 SSE 响应累计最大 256 MiB。手机缓冲超过 8 MiB 后取消读取。握手期限 25 秒（桌面在收到隧道连接后等待 15 秒）。响应头只传递内容、缓存、Range、Location 和 Allow；不转发访问密钥、Cookie 或任意 Host。

认证后的手机拥有工作台 API 权限。桌面在内存中注入本机访问密钥后，仍走原路由、公共鉴权、工作区隔离与审批策略；本机访问密钥不发送给手机。手机使用每个配对独立的虚拟 origin，切换设备时卸载旧传输；断线使在途读取失败，不自动重放写操作。

聊天处理器由应用拥有，断线时解除手机等待，后台轮次继续，重连后从现有历史与执行状态恢复。关闭应用先停止接收与断开中继，再取消 Agent 并等待原生处理器退出，避免未完成轮次阻塞中继关闭。

## 移动应用

构建和系统依赖见 [mobile/README.md](../mobile/README.md)。Tauri 使用原生 WebSocket 插件和原生扫码插件；浏览器预览使用浏览器 WebSocket，并提供粘贴链接。配对保存在原生应用私有目录，Unix 权限 0600；浏览器预览使用自身 localStorage。不会保存桌面 Web 访问密钥或中继注册密钥。

手机界面位于 `mobile/src/MobileWorkspace.tsx`，会话状态由 `session-store.ts` 拥有。miuix 风格的悬浮玻璃底栏、圆角分组、按压和页面切换由现有 NextUI / Framer Motion 与手机 CSS 实现；不是引入 Compose 原生组件。正文保留 Loopra 渲染，字号独立设置为 15 / 16 / 18px，思考与工具默认折叠。减少动态效果遵从系统，玻璃效果在减少透明效果或不支持 backdrop-filter 时回退到实体背景。

手机通过原接口加载项目、会话、历史、模型与引擎目录，发送流式聊天、带 requestId 的停止请求、权限审批和 Agent 提问答案。切换会话不取消流；断流后轮询执行状态并恢复历史、审批和提问。每个流只更新所属会话，旧读取不回写新选择。向上阅读时暂停自动跟随，点击「回到最新」恢复。连接断开后不会重放写请求。

### 液态玻璃底栏

`glass-optics.ts` 按胶囊或圆形控件尺寸追踪垂直入射光，折射率取 1.5，曲面只位于边缘，平坦中心保持中性。位移编码到 RG，`LiquidGlass.tsx` 用 SVG `feDisplacementMap` 扭曲实际背景，三个通道有轻微位移差以产生色散，再叠加按表面法线生成的高光。图标、文字和触控按钮位于独立的清晰层。该思路参考 [Kube 的折射推导](https://kube.io/blog/liquid-glass-css-svg/)；不是以模糊代替折射。

尺寸变化时重新生成并缓存贴图，滚动和拖动不重新逐像素计算。只给悬浮底栏和新建按钮各一个小面积滤镜，选中滑块使用同一底栏上的填充层，避免多层背景滤镜相互截断。`LiquidNavigation.tsx` 提供原生按钮点击、指针捕获拖动、形变与弹簧归位；指针取消不切换页面。减少动态效果关闭弹性运动，减少透明效果关闭光学滤镜。

SVG 作为 `backdrop-filter` 的折射路径面向 Chromium（含 Android WebView）；其他引擎使用可读的模糊或实体背景回退。这个实现不能承诺与 iOS 系统材质逐像素一致，实际性能与效果仍依赖手机 WebView 和 GPU。可对照[已有实现的 Android 渲染说明](https://github.com/Meapri/liquid-glass-web)。开发验收通过在相同背景上将位移缩放归零与正常值比较，确认变化来自折射，而非仅由阴影和模糊产生。

当前不提供交互式终端、插件 iframe、完整编辑器、历史回滚、系统文件对话框与桌面窗口桥接；外部 Agent 的模型和权限沿用桌面设置。iOS 需要 macOS/Xcode；相机权限、系统安全区和软键盘仍需真机验收。

## 验证

默认 Go 测试不依赖外网和个人配置。`mobile/pnpm test` 覆盖配对校验、双向认证、并行请求、SSE、取消、断线、篡改、虚拟 origin 隔离及手机会话的导航隔离、精确停止、历史恢复、审批和提问。`mobile/tests/ui-fixture.html` 只供开发预览，不进入应用产物。可选真实互操作测试需要 `web/` 与 `mobile/` 已安装依赖，以及独立的 alma-relay checkout：

```powershell
# 在 alma-relay checkout 先执行 npm ci --ignore-scripts。
$env:LOOPRA_MOBILE_INTEROP = '1'
$env:LOOPRA_ALMA_RELAY_SOURCE = 'C:\path\to\alma-relay'
go test ./internal/controller -run TestLoopraMobileInteroperability -v -count=1 -timeout 60s
```

互操作使用真正的移动传输和未经改写的 `LoopraClient`，模型为本地脚本，所有会话位于测试临时目录，不调用付费模型。

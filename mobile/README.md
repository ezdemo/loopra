# Loopra Mobile

基于 Tauri v2 的 Android / iOS 客户端。手机布局、导航与会话状态在 `mobile/src` 独立实现，正文、Markdown、思考、工具和文件差异复用 Loopra 的 `Conversation` / `BlockRenderer`。桌面与手机通过自建 alma-relay 交换端到端加密的原生 HTTP / SSE 接口。无需 Alma 客户端。

界面采用液态玻璃风格的移动应用面板：中性底图、磨砂分组、悬浮导航和聊天输入面板，沿用 React / NextUI / Framer Motion。默认界面比例为 93.5%（原大小的 110%），字号有 15 / 16 / 18px 三档，不支持双指缩放。支持项目筛选（选中项目标签自动滚动居中）、会话搜索、新建和切换、流式回复、停止、审批和 Agent 提问；会话列表图标与桌面端一致，按 `agentId` 展示对应 Agent 图标。思考、工具详情默认折叠。回复运行中仍可继续发送，消息按会话排队，可撤回、编辑或引导优先发送，当前回复结束并确认后台空闲后自动按顺序发送下一条。回复设置读取当前会话的真实模型、思考强度以及 Agent 暴露的全部 `configOptions`，包括第三方 ACP 的模型、权限模式、布尔项和自定义选项；模型较多时使用带搜索和滚动列表的独立选择浮层。长按选择只在会话正文和输入框中启用；减少动态效果、减少透明效果和不支持背景模糊的系统有对应回退。

底栏使用 CSS 背景模糊、半透明中性色与边缘高光，模糊直接应用于圆角表面，避免 SVG 折射层在 Android WebView 上产生灰色矩形和清晰透字。标签、选中态、新建按钮和触控区域放在清晰内容层；选中框可跟手拖动，松手后吸附到最近的会话或项目页。底部面板的抓手可上下拖动，向下超过阈值关闭，向上有弹性反馈。列表、聊天容器与底部面板使用统一的中性磨砂色，减少透明效果或不支持背景模糊时回退为实体表面。实现依据与限制见 [移动协议文档](../docs/MOBILE.md#液态玻璃底栏)。

底栏设置中的「连接」进入独立管理页，可修改实例名称、查看连接状态和中继、重新连接、前往新实例或移除当前配对。重新连接保留当前页面、会话列表、聊天草稿和排队消息，不从配对页重新进入。原生连接、端到端加密、请求分发、缓冲与退避重连由 Rust 持有；回到前台时先检查桌面隧道，健康连接与回复流保持不变，TS 只适配 API 和流并驱动界面。Android 状态栏图标随应用亮暗主题同步，手动选择深色时也保持可读。

Android 系统返回键先关闭弹层，再从聊天或连接管理页返回上一级；只有根页面才退出应用。扫码页使用独立原生 Activity，返回会取消扫描并回到配对页。

## 开发

```powershell
cd web
pnpm install --frozen-lockfile
cd ../mobile
pnpm install --frozen-lockfile
pnpm dev
```

浏览器打开 `http://127.0.0.1:1421`，粘贴桌面「设置 → 连接与帮助 → 远程访问」提供的 `loopra://` 链接。原生应用支持相机扫码；浏览器预览使用粘贴链接。桌面需要运行包含移动协议的新版本。

```powershell
pnpm test
pnpm build
```

原生传输核心与 Tauri 壳层：

```powershell
cd src-tauri
cargo test -p loopra-relay
cargo check -p loopra-mobile
```

Rust 协议测试使用本地 Node / ws 响应端，需要先安装 `mobile/` 的前端依赖；无需桌面实例、真实配对或外网。

## Android

按 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/) 安装 Rust、Android Studio、SDK/NDK 和 Java。Windows 原生 Rust 构建脚本还需要 Visual Studio C++ Build Tools 与 Windows SDK；只有 Rust 和 Android NDK 并不足够。`JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` 应指向各自本机目录，不写入仓库。当前 Android 工程使用 compile/target SDK 37、最低 SDK 24。

一键打包（当前 Windows 环境）：

```powershell
pnpm android:debug
```

完整构建步骤、备用 MinGW 工具链、条码插件权限限制、无符号链接权限时的打包方式和产物校验见 [ANDROID_BUILD.md](ANDROID_BUILD.md)。

```powershell
pnpm android:dev
# 本地可安装调试 APK；aarch64 对应大多数实体安卓手机。
pnpm tauri android build --debug --apk --target aarch64
# 正式产物需要自行配置 Android 签名。
pnpm android:build
```

如果 Windows 只在动态库编译完成后报告无法创建符号链接，可用复制方式完成同一调试包的 Gradle 打包，无需修改系统安全设置：

```powershell
./scripts/package-android.ps1
```

该步骤验证已有 ARM64 ELF、复制并去除副本的调试符号，保留原始库，再构建 Java/Kotlin、资源并签名，按版本输出到仓库 `bin/loopra-mobile-<version>-arm64-debug.apk`。它不替代 Rust 编译。Android 扫码使用随包内置的 ZXing 扫描 Activity，不依赖 Google Play Services；返回键会关闭扫描并回到配对页。

Android 工程位于 `src-tauri/gen/android/`，包含扫码权限和软键盘调整。仅在需要重新生成工程时执行 `pnpm android:init`，之后核对 AndroidManifest 中相机权限与 `adjustResize`。构建、缓存、密钥库和本机 SDK 路径均被忽略。

## iOS

在 macOS 安装 Xcode 和对应 Rust target，然后执行：

```sh
pnpm ios:init
pnpm ios:dev
```

`src-tauri/Info.ios.plist` 已提供相机用途说明。Windows 无法构建或验收 iOS 应用。

## Android 启动图标

手机桌面图标使用整块白底，蓝色环与 L 居中留白。自适应图标把透明前景与白色背景分层，圆形与方圆形使用同一组资源；支持主题图标的桌面可使用单色层着色。应用内切换深色主题不改变桌面图标。

矢量源文件和生成配置在 `icons/launcher*.svg`、`icons/launcher.json`。修改后从 `mobile/` 执行 `./scripts/generate-icons.ps1`，同步更新 `src-tauri/icons/android/` 与 Android 工程资源，再打包 APK。该命令不改电脑端、网页或 iOS 图标。

## 配对与连接

公网中继使用有效 HTTPS 域名。桌面启用后扫码，手机先验证端到端握手，再调用 `/api/mobile/handshake` 核对私有协议版本；成功后才保存配对并打开手机会话列表。重置配对后，旧二维码立即失效，需要扫描新码。原生端在首次离线或连接中断后持续退避重连，间隔最长 30 秒；连接等待可取消，身份验证失败或协议不兼容需重新配对或升级。回到前台会立即检查连接，健康连接不中断，也保留手动检查入口；在途请求断线失败，写请求不会自动重放。

Android 连接桌面后使用前台服务保持后台连接，并显示「正在保持桌面连接」通知；首次请求通知权限，拒绝不阻止连接。断开、移除配对、退出应用或从最近任务移除后停止服务。WebView 暂停不会主动关闭 Rust 连接，恢复后同步原生状态。深度待机、厂商省电策略或系统强制停止仍可能断网，恢复后自动重连并同步会话；未申请省电白名单或常驻唤醒锁。

重连时在当前页面顶部持续显示进度，无需进入连接管理页；「立即重试」会等待检查结果，重复点击不会创建新连接。恢复后短暂提示成功，自动刷新列表、配置与当前会话状态，保留页面、阅读位置和草稿。自动重连的退避等待不会隐藏进度；手动检查健康连接也会明确提示结果。

原生配对只保存在应用私有目录；「忘记连接」会删除。手机不持有桌面访问密钥或中继注册密钥。手机当前提供上述会话功能，未移植终端、编辑器、插件界面、历史回滚与全量桌面设置；外部 Agent 的模型与权限沿用桌面配置。文件变更支持原有消息内差异展示。

`pnpm dev` 下的 `/tests/ui-fixture.html` 使用合成会话验收布局、审批、提问和流式滚动；添加 `?projects=12` 可检查多项目选择后的标签自动滚动。不访问桌面数据，不进入 APK 构建入口。

协议、管理 API、限制与互操作命令见 [移动协议](../docs/MOBILE.md)。Android 扫码使用原生 ZXing Activity，iOS 保留 Tauri 官方 [Barcode Scanner](https://v2.tauri.app/plugin/barcode-scanner/) 插件；原生通信使用 `src-tauri/relay-core/` 中的 Rust 传输核心，浏览器预览保留独立 TS 传输。

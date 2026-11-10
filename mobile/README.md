# Loopra Mobile

基于 Tauri v2 的 Android / iOS 客户端。手机布局、导航与会话状态在 `mobile/src` 独立实现，正文、Markdown、思考、工具和文件差异复用 Loopra 的 `Conversation` / `BlockRenderer`。桌面与手机通过自建 alma-relay 交换端到端加密的原生 HTTP / SSE 接口。无需 Alma 客户端。

界面采用 miuix 风格的圆角分组、悬浮玻璃底栏和触控动效，沿用 React / NextUI / Framer Motion。支持项目筛选、会话搜索、新建和切换、流式回复、停止、审批和 Agent 提问。正文字号有 15 / 16 / 18px 三档，外观可跟随系统；思考、工具详情默认折叠。减少动态效果、减少透明效果和不支持背景模糊的系统有对应回退。

底栏与新建按钮使用按真实尺寸生成的凸曲面位移贴图、SVG 背景折射、轻微 RGB 色散和边缘高光；标签不参与滤镜。可点击或横向拖动底栏选中项，带按压形变和弹簧回弹。Android Chromium WebView 走折射路径，其他引擎提供模糊回退，系统减少透明效果时使用实体背景。实现依据与限制见 [移动协议文档](../docs/MOBILE.md#液态玻璃底栏)。

## 开发

```powershell
cd web
pnpm install --frozen-lockfile
cd ../mobile
pnpm install --frozen-lockfile
pnpm dev
```

浏览器打开 `http://127.0.0.1:1420`，粘贴桌面「设置 → 连接与帮助 → 远程访问」提供的 `loopra://` 链接。原生应用支持相机扫码；浏览器预览使用粘贴链接。桌面需要运行包含移动协议的新版本。

```powershell
pnpm test
pnpm build
```

## Android

按 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/) 安装 Rust、Android Studio、SDK/NDK 和 Java。Windows 原生 Rust 构建脚本还需要 Visual Studio C++ Build Tools 与 Windows SDK；只有 Rust 和 Android NDK 并不足够。`JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` 应指向各自本机目录，不写入仓库。当前 Android 工程使用 compile/target SDK 37、最低 SDK 24。

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

该步骤验证已有 ARM64 ELF、复制并去除副本的调试符号，保留原始库，再构建 Java/Kotlin、资源并签名，按版本输出到仓库 `bin/loopra-mobile-<version>-arm64-debug.apk`。它不替代 Rust 编译。扫码模型随包内置，首次扫码不依赖 Google Play Services 下载模型。

Android 工程位于 `src-tauri/gen/android/`，包含扫码权限和软键盘调整。仅在需要重新生成工程时执行 `pnpm android:init`，之后核对 AndroidManifest 中相机权限与 `adjustResize`。构建、缓存、密钥库和本机 SDK 路径均被忽略。

## iOS

在 macOS 安装 Xcode 和对应 Rust target，然后执行：

```sh
pnpm ios:init
pnpm ios:dev
```

`src-tauri/Info.ios.plist` 已提供相机用途说明。Windows 无法构建或验收 iOS 应用。

## 配对与连接

公网中继使用有效 HTTPS 域名。桌面启用后扫码，手机先验证端到端握手，再调用 `/api/mobile/handshake` 核对私有协议版本；成功后才保存配对并打开手机会话列表。重置配对后，旧二维码立即失效，需要扫描新码。连接断开后通过重连按钮恢复，写请求不会自动重放。

原生配对只保存在应用私有目录；「忘记连接」会删除。手机不持有桌面访问密钥或中继注册密钥。手机当前提供上述会话功能，未移植终端、编辑器、插件界面、历史回滚与全量桌面设置；外部 Agent 的模型与权限沿用桌面配置。文件变更支持原有消息内差异展示。

`pnpm dev` 下的 `/tests/ui-fixture.html` 使用合成会话验收布局、审批、提问和流式滚动，不访问桌面数据，不进入 APK 构建入口。

协议、管理 API、限制与互操作命令见 [移动协议](../docs/MOBILE.md)。扫码与原生通信使用 Tauri 官方的 [Barcode Scanner](https://v2.tauri.app/plugin/barcode-scanner/) 和 [Websocket](https://v2.tauri.app/plugin/websocket/) 插件。

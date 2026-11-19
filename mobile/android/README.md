# Loopra Native（Android 原生客户端）

使用 Jetpack Compose 与 [Backdrop](https://github.com/Kyant0/AndroidLiquidGlass) 液态玻璃
编写的原生 Android 客户端。**不使用 WebView**：聊天、历史、审批与设置全部走原生界面。
传输层为纯 Kotlin 实现（OkHttp WebSocket + JCA/JCE），按 `mobile/src-tauri/relay-core`
的生产 `loopra-relay` 协议逐条对齐：配对认证、P-256 ECDH + HKDF E2E 加密、AES-GCM
帧序、隧道内 HTTP 请求分发、缓冲与背压、端到端探测、退避重连与精确取消。
工程内无 Rust、JNI、cargo 或 NDK 依赖。

它与 `mobile/` 下的 Tauri/React 版是两个独立应用：包名 `app.loopra.android`，
应用名 **Loopra Native**，可与 `app.loopra.mobile` 并存安装，互不影响。
现有 Tauri 工程未做任何改动。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `app/` | Compose 应用：落地页、会话列表、聊天、审批、设置弹层 |
| `app/src/main/java/app/loopra/android/data/` | 配对存储、RelayClient/RelayCrypto 传输、仓库与 SSE |
| `app/src/test/` | JVM 单元测试（配对、加密、SSE、归约、脚本化隧道假实现）与 Node 互通测试 |

## 环境

- JDK 21（Temurin 即可）、Android SDK（platforms android-36、build-tools 36）
- Gradle 9.6.1（wrapper 自带）、AGP 9.3.1、Kotlin 2.3.21、Compose BOM 2025.11.00、
  Backdrop 1.0.6、OkHttp 4.12.0
- 无需 Rust、cargo、NDK；互通测试另需 Node + `mobile/node_modules`（`ws`）。

## 构建

```powershell
cd mobile/android
./gradlew.bat :app:assembleDebug
```

非 Windows 环境使用 `./gradlew :app:assembleDebug`。产物为
`app/build/outputs/apk/debug/app-debug.apk`；可复制为
`<repo>/bin/loopra-mobile-native-0.1.3-debug.apk`。

单元测试与静态检查：

```powershell
./gradlew.bat :app:testDebugUnitTest :app:lintDebug
```

`RelayInteroperabilityTest` 会在本地回环自动拉起
`mobile/tests/native-relay-peer.mjs`（Node WebCrypto + ws 独立实现）完成真实
加密握手、回显、SSE、取消、探测与断线重连验证；子进程在测试结束时销毁。

Android Studio：直接打开 `mobile/android/` 目录即可，无需其他前置构建。

## 安装与连接

```powershell
adb install -r <repo>/bin/loopra-mobile-native-0.1.3-debug.apk
```

桌面端 → 设置 → 远程访问，展示配对二维码或复制 `loopra://connect?…` 链接。
应用内粘贴链接或扫码连接；也支持系统直接打开 `loopra://connect` 深链
（已连接时需确认后才替换）。配对只保存在应用私有免备份目录，
界面只显示实例名与中继主机。

## 玻璃效果与降级

- Android 12+：`drawBackdrop` 采样背景与滚动内容，vibrancy + 18dp 模糊 +
  主题化半透明着色；Android 13+ 追加 `lens` 折射。
- Android 11 及以下或开启「减少透明效果」：自动退化为不透明语义底色，
  功能保持一致（视觉为降级近似，不保证像素级一致）。
- 玻璃只通过 `rememberLayerBackdrop` 采集背景与滚动内容，玻璃自身不参与采样，
  避免循环反馈。

## 当前范围

界面结构与功能对齐移动版（mobile/）：工作台首页（会话搜索/项目筛选/
项目卡片/底部玻璃坞）、连接落地页、连接管理（重命名/重连/连接其他桌面/
移除）、外观设置（主题、字号 15/16/18、减少透明效果）；聊天页（消息流、
消息复制/重编辑/时间戳、排队消息、审批卡片、问询表单、回复设置）。
智能体图标与 web/src/components/AgentIcon.tsx 同源矢量数据
（codex/devin/claude 与通用 Bot）。视觉为目标对齐而非逐像素复刻，
未经真机对比验证。配对候选只在首次认证成功后写入存储，
取消或失败不影响已保存实例。

已实现：配对连接（链接/扫码/深链）、工作区与会话列表、本地草稿新会话
（prepare 推迟到首次发送/打开回复设置，支持项目与引擎选择）、历史读取、
流式回复（content/reasoning/tool/sub_* 块，相邻思考/工具自动折叠）、
CommonMark 渲染（标题/列表/引用/代码块/GFM 表格/链接，HTML 与图片降级
为文本）、精确中断、待处理审批恢复与提交、排队消息（上限 50，空闲确认
后按序派发，投递未知时标记需人工复核）、elicitation 问询表单
（GET/POST `/api/chat/elicitation(s)`，支持 enum/oneOf/数组/密文/必填
与边界校验，不支持的字段引导到桌面端）、断线重连恢复、浅色/深色主题
与玻璃降级、前台保活通知。回复设置面板与引擎选择同服务端
`/api/agent-engines` 数据对齐。

已知差距：图片与附件预览仍降级为文本，文件变更只显示列表和统计
（未移植 diff 视图）；新会话的项目选择器采用 Android 下拉菜单。
视觉未经同机逐页对照。

问询表单沿用桌面端分页：每页一个问题，`_note`/`question_N_custom`/
`_meta.codex` 伴生说明字段并入宿主同页，宿主缺失时独立成页。
外部 ACP 会话保持 `agentId`/`customAgentId` 透传，可正常续聊。

后台连接只在前台服务存活期间保持，不申请唤醒锁，不承诺 Doze/厂商省电
策略下持续在线。

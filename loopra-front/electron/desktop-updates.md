# 桌面端自动更新

桌面正式版使用 `electron-updater`，支持 Windows NSIS、Linux DEB/AppImage，以及正式签名或 ad-hoc/未签名的 macOS ZIP。未正式签名的 macOS 使用自定义安装器，其余平台使用原有安装器。启动 10 秒后检查更新，每 4 小时再检查一次；发现正式新版后后台下载。顶部显示下载进度，完成后提供“重启并安装”。正常退出时也会自动安装，运行中的会话不会因下载完成而被强制关闭。显式重启按钮在当前任务或核心服务更新期间禁用。

桌面版本读取 Electron `app.getVersion()`；核心服务版本仍单独显示。桌面更新弹窗提供与核心更新相同的 GitHub 直连和 ghproxy 镜像列表，选择保存在 Electron 用户数据目录的 `desktop-update.json`，重启后自动恢复。更新清单与安装包均使用所选下载源；切换时先取消并等待旧下载结束，再重新检查并下载。验证、下载完成及安装期间禁止切换，避免替换已准备好的更新。

更新包来自 `ezdemo/loopra-release` 的 GitHub Releases。主进程只接受内置列表中的源，固定官方仓库地址；通常直连使用 GitHub provider，镜像使用固定 Releases 下载目录的 generic provider。未正式签名的 macOS 在直连和镜像下均使用 generic provider 的独立 `latest-unsigned-mac.yml`，完整下载当前应用架构对应的 ZIP。下载保留 SHA-512 完整性校验及 Electron 网络代理；正式签名版继续保留系统签名验证。镜像不使用差分与多段 Range 请求。开发模式及未知 Linux 打包方式保留发布页下载，并显示原因。

桌面更新弹窗展示当前版本、目标版本、下载大小和速度，以及当前版本之后至目标版本的正式发布日志；已是最新版时展示当前版本的说明。日志通过受主窗口校验的 IPC 在主进程中读取固定的官方 GitHub Releases API，遵循 Electron 会话代理，排除草稿和预发布，按版本从新到旧排列。请求合并并缓存 5 分钟，发现缓存之外的新目标会立即刷新；20 秒超时，可独立重试，不影响后台更新。最多分页读取最近 1000 条发布记录，历史超出范围时显示提示。Markdown 保留分类和折叠提交记录，过滤不安全 HTML，隐藏重复的下载链接和构建元数据。

发布需要源码仓库和相邻 `loopra-release` 仓库的改动同时合入 main。发布流程生成并上传 Windows `latest.yml`、Linux `latest-linux.yml`、macOS `latest-unsigned-mac.yml` 及对应软件包；正式签名的 macOS 构建还上传 `latest-mac.yml` 和 ZIP 的差分文件。先校验每个清单条目的版本、软件包名称、大小及 SHA-512，再连同其余平台软件包一起核对 SHA-256 后发布。清单不能在生成后单独改软件包文件名。

macOS 复用发布仓库现有的 `MAC_CERTIFICATE_P12` / `MAC_CERTIFICATE_P12_PASSWORD`。CI 在正式签名分支设置包内 `loopraDesktopUpdate.macSigned=true`，并检查产物的 Developer ID 签名。没有证书则生成 ad-hoc ZIP，将标记设为 false，仅提供独立的 `latest-unsigned-mac.yml`；不会向旧的正式签名客户端发布 ad-hoc 更新。正式签名版还要等 Squirrel 完成系统验证，才能进入可安装状态；签名失败会保留错误供重试，不会显示安装按钮。Apple 公证继续复用已有凭据。

自定义 macOS 安装器在应用旁边创建暂存目录，检查 ZIP 路径、应用标识、版本及可执行文件，准备完成才显示安装按钮。独立 shell 助手等主进程退出后，通过同一文件系统上的重命名替换应用；替换或重新打开失败时恢复旧应用，并记录安装日志及下次启动可读的错误。点击“重启并安装”会重新打开应用，普通退出安装后不重新打开。应用需位于可写目录，不能从磁盘镜像或 App Translocation 目录更新；该安装器不会请求提权或移除 Gatekeeper 隔离属性。首次安装仍遵循系统打开规则。正式签名构建也提供独立清单，允许未签名客户端后续迁移到正式签名版。

Linux 根据 `APPIMAGE` 环境和打包器写入的 `resources/package-type` 选择 AppImageUpdater/DebUpdater，AppImage 优先，避免共享构建目录中的 DEB 标记导致误判。DEB 安装通过系统包管理器完成，可能出现管理员授权提示；AppImage 更新原文件，需要其所在目录可写。未知包格式不会被当作 AppImage 强行更新。

旧版没有此更新器，用户需要先手动安装一次包含本功能的桌面版。之后的新 Release 才能自动更新；升级后的内置核心继续按桌面启动流程优先更新并启动，再进入主页面。

本地验证：在 `loopra-front` 运行 `pnpm typecheck:web`、`node --test --test-concurrency=4 web/tests/*.test.mjs`、`pnpm build:vite`；在 `loopra-release` 运行 `node --test tests/*.test.mjs`。测试使用模拟下载和安装器，不退出或覆盖正在运行的用户应用。真实跨版本更新需要各平台两次正式打包，验证下载、校验、安装、授权和启动流程；不会在开发环境强制更新。

# 桌面端自动更新

桌面正式版使用 `electron-updater`，支持 Windows NSIS、Linux DEB/AppImage 和使用 Developer ID Application 正式签名的 macOS ZIP。启动 10 秒后检查更新，每 4 小时再检查一次；发现正式新版后后台下载。顶部显示下载进度，完成后提供“重启并安装”。正常退出时也会自动安装，运行中的会话不会因下载完成而被强制关闭。显式重启按钮在当前任务或核心服务更新期间禁用。

桌面版本读取 Electron `app.getVersion()`；核心服务版本仍单独显示。更新包来自 `ezdemo/loopra-release` 的 GitHub Releases，不接受渲染进程指定的更新地址。更新请求和下载使用设置中的 Electron 代理。开发模式、临时签名的 macOS 版本及未知 Linux 打包方式保留发布页下载，并显示原因。

发布需要源码仓库和相邻 `loopra-release` 仓库的改动同时合入 main。发布流程生成并上传 Windows `latest.yml`、Linux `latest-linux.yml` 及对应软件包；正式签名的 macOS 构建还上传 `latest-mac.yml` 和 ZIP 的差分文件。先校验每个清单条目的版本、软件包名称、大小及 SHA-512，再连同其余平台软件包一起核对 SHA-256 后发布。清单不能在生成后单独改软件包文件名。

macOS 复用发布仓库现有的 `MAC_CERTIFICATE_P12` / `MAC_CERTIFICATE_P12_PASSWORD`。CI 在正式签名分支设置包内 `loopraDesktopUpdate.macSigned=true`，并检查产物的 Developer ID 签名。没有证书则保留 ad-hoc ZIP，将标记设为 false，发布时不提供该版本的 macOS 自动更新清单。正式签名版还要等 Squirrel 完成系统验证，才能进入可安装状态；签名失败会保留错误供重试，不会显示安装按钮。Apple 公证继续复用已有凭据。

Linux 根据 `APPIMAGE` 环境和打包器写入的 `resources/package-type` 选择 AppImageUpdater/DebUpdater，AppImage 优先，避免共享构建目录中的 DEB 标记导致误判。DEB 安装通过系统包管理器完成，可能出现管理员授权提示；AppImage 更新原文件，需要其所在目录可写。未知包格式不会被当作 AppImage 强行更新。

旧版没有此更新器，用户需要先手动安装一次包含本功能的桌面版。之后的新 Release 才能自动更新；升级后的内置核心继续按桌面启动流程优先更新并启动，再进入主页面。

本地验证：在 `loopra-front` 运行 `pnpm typecheck:web`、`node --test --test-concurrency=4 web/tests/*.test.mjs`、`pnpm build:vite`；在 `loopra-release` 运行 `node --test tests/*.test.mjs`。测试使用模拟下载和安装器，不退出或覆盖正在运行的用户应用。真实跨版本更新需要各平台两次正式打包，验证下载、校验、安装、授权和启动流程；不会在开发环境强制更新。

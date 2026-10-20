# 桌面端自动更新

Windows 正式安装版使用 `electron-updater`（NSIS），启动 10 秒后检查更新，每 4 小时再检查一次；发现正式新版后后台下载。顶部显示下载进度，完成后提供“重启并安装”。正常退出时也会自动安装，运行中的会话不会因下载完成而被强制关闭。显式重启按钮在当前任务或核心服务更新期间禁用。

桌面版本读取 Electron `app.getVersion()`；核心服务版本仍单独显示。更新包来自 `ezdemo/loopra-release` 的 GitHub Releases，不接受渲染进程指定的更新地址。更新请求和下载使用设置中的 Electron 代理。开发模式、macOS 和 Linux 暂时保留发布页手动下载安装。

发布需要源码仓库和相邻 `loopra-release` 仓库的改动同时合入 main。发布流程生成并上传 `latest.yml`、`Loopra-windows-x64.exe` 和 `Loopra-windows-x64.exe.blockmap`，先校验清单版本、安装包名称、大小、SHA-512，再连同其余平台软件包一起核对 SHA-256 后发布。清单不能在生成后单独改安装包文件名。

旧版没有此更新器，用户需要先手动安装一次包含本功能的桌面版。之后的新 Release 才能自动更新；升级后的内置核心继续按桌面启动流程优先更新并启动，再进入主页面。

本地验证：在 `loopra-front` 运行 `pnpm typecheck:web`、`node --test web/tests/*.test.mjs`、`pnpm build:vite`；在 `loopra-release` 运行 `node --test tests/*.test.mjs`。测试使用模拟下载和安装器，不退出或覆盖正在运行的用户应用。真实跨版本更新需要两次正式打包，验证下载、校验、安装和启动流程；不会在开发环境强制更新。

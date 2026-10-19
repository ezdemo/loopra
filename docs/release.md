# 独立发布仓库

Loopra 的发版工作流、安装脚本和 npm 分发包已迁到 [ezdemo/loopra-release](https://github.com/ezdemo/loopra-release)。完整配置与操作见[发版仓库 README](https://github.com/ezdemo/loopra-release#readme)。

本仓库继续保存源码、版本号、Maven / Electron 应用构建配置和后端测试。`.github/workflows/backend-checks.yml` 不受迁移影响。原 `.github/workflows/build.yml`、`.release/` 和 Gitee 打包流水线由独立发版仓库接管。

发布前运行 `./bump-version.ps1 -Version <版本号>`，将源码与版本变更合并到 **GitHub 的 main 分支**。然后在 `loopra-release` 运行 **Build & Release** 工作流或推送与源码版本相同的 `v*` 标签。工作流启动时锁定 `main` 的提交 SHA，各平台使用相同源码，产物上传到 `loopra-release` 的 Release 草稿。人工检查并正式发布后触发 npm 分发。

本地打包时，将发版仓库克隆在旁边，使用其脚本并通过 `LOOPRA_SOURCE_DIR` 或 PowerShell 的 `-SourceDir` 指定本仓库路径。前端同步、核心嵌入和桌面打包说明见发版仓库 README。

# Loopra Web 工作台

Web 与 Electron 主窗口默认采用 React、TypeScript 和 NextUI，源码位于本目录。项目、会话、聊天流、模型渠道、远程模型获取、工具、Git 改动与后台命令通过 Loopra API 连接后端。

## 开发与验证

环境要求与全部前端入口见 [前端说明](../README.md)。在 `loopra-front` 目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:electron
pnpm test:web
pnpm build
```

开发地址为 `http://127.0.0.1:3000/`，默认通过 `/api` 代理连接本机 4567 后端。设置 → 服务器可以更换连接地址。生产 Web 默认使用当前站点地址，支持后端自定义端口；保留原控制台的 `loopra-api-base` 地址偏好，并兼容 `public/config.json` 中的自定义服务地址。新界面的已有地址偏好优先。

`pnpm dev:electron` 会构建主进程和预加载脚本，复用已有 Loopra Vite 服务或在 3000 端口启动服务。Windows 下若项目目录中的 Electron 在启动前报 `0x80000003`，命令会将同版本公共运行时缓存到 `%LOCALAPPDATA%/Loopra/development`，为该运行时补齐 Chromium 子进程所需的读取、执行权限并验证后启动；Vite 临时文件位于项目的 `.cache/desktop-temp`。

构建产物仍输出到 `dist/renderer`，使用 [loopra-release](https://github.com/ezdemo/loopra-release) 仓库中的 `.release/ci-sync-web-assets.sh` 或 `.release/windows_package.ps1`，指定源码目录后同步到 Java 静态资源。`index.html` 是新 Web 工作台；`legacy.html` 保留旧 Vue 控制台用于兼容和对照。资源编辑、技能市场、插件及扩展安装已有 React 入口。Electron 主窗口默认使用新 React UI，通过桌面桥接读取实际核心服务端口；核心已运行时直接进入工作台。安装、更新、宠物及其他独立辅助窗口保留原 Vue 页面，样式按入口分别加载。功能对照及界面验收见 [LEGACY_PARITY.md](LEGACY_PARITY.md)。

## 界面与行为

- 聊天正文、推理、工具执行、文件改动、选择与审批使用真实 SSE 和历史数据。
- 输入栏支持模型选择、推理强度、权限、附件、文件引用、关联项目与技能。
- “管理项目会话”弹窗支持修改展示名称：`PUT /api/workspaces/{hash}/name`，请求体 `{ "displayName": "名称" }`；留空恢复文件夹名称。名称保存在服务端项目元数据中，项目路径、hash 和会话记录保持不变。
- “管理项目”的目录选择按钮在 Web 和 Electron 中均可用：两端统一调用 `POST /api/system/pick-directory`（请求体 `{ "path": "初始目录" }`），通过 SWT 在后端所在电脑打开系统选择器。选定目录后自动添加并进入项目，关闭管理弹窗；取消选择保持当前项目。也可手动输入路径后点击“添加项目”。后端分发包内含 Windows x64、Linux x64/ARM64、macOS x64/ARM64 的 SWT 运行库。
- 顶栏文件夹及打开方式菜单统一调用 `POST /api/system/open-workspace`，请求体为 `{ "workspaceHash": "项目标识", "application": "folder|powershell|git-bash|bash|terminal" }`。Java 根据项目标识解析真实目录，在服务所在电脑启动文件管理器或终端，不接受任意命令。Windows 的 Bash 使用 Git for Windows，默认终端使用 PowerShell；macOS 使用 Terminal，Linux 使用已安装的桌面终端。程序未安装或启动失败时会在页面显示错误。“后台命令”仍查看应用内任务。
- 供应商编辑支持远程模型获取，NextUI 弹窗内可搜索、多选、批量添加。添加只更新草稿，点击保存配置后写入后端；已有模型参数保持原值。
- 每个模型可配置可选的 `displayName` 展示名称，保存到服务端模型渠道配置。聊天选择器、默认模型和 Git 生成模型优先显示该名称，留空回退到原模型名；模型 ID、请求参数和已保存的模型选择不变。选择器同时搜索展示名称与原始 ID，长名称可换行并悬停查看全文。
- 同一窗口支持最多 4 个会话并行运行，切换或新建会话不会停止已有回复。请求、停止操作、速度和消息队列按会话隔离；同一会话的后续消息仍排队，侧栏标记运行状态和后台完成的新回复。切换后端或关闭窗口会断开本地订阅，后端任务由服务继续管理；再次打开时可通过运行状态轮询查看。运行期间阻止会重建模型渠道的全局配置修改。
- 80%–150% 连续界面缩放同步调整文字、侧栏、按钮、图标和弹层。保留 NextUI 原生交互动效。
- API 密钥由后端保存和脱敏；本地存储仅保存外观、服务地址等偏好，不保存渠道密钥。

后端没有会话归档接口，隐藏/恢复仅影响当前浏览器；上下文用量含本地估算；语言切换覆盖侧栏和输入框，管理页面仍以中文为主。回复完成提示音使用浏览器音频能力。目录选择、打开文件夹与系统终端可通过后端 API 在服务所在电脑执行；应用内原生终端、窗口控制等能力依赖 Electron 桥接。

## 主要入口

- `src/backend.ts`：HTTP/SSE、配置和历史协议适配。
- `src/App.tsx`、`src/useLoopra.ts`：工作区、会话与运行配置。
- `src/layout/`：Sidebar、Header、HomeView、ChatDock 等外壳组件；设计 token 位于 `src/styles.css` 的 `:root` / `:root.dark`（颜色、圆角、间距、阴影），NextUI 主题在 `tailwind.config.js` 中映射到同一套色值。
- `src/components/Composer.tsx`：输入栏与模型选择。
- `src/components/Settings.tsx`：NextUI 设置。
- `src/components/RemoteModelsPicker.tsx`：远程模型选择弹窗。
- `tests/`：聊天块、输入栏、配置、后端协议和迁移回归验证。

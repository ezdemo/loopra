# Loopra Frontend

Loopra 的 Web 与 Electron 桌面前端。默认主工作台使用 React、TypeScript 和 NextUI；Vue 保留用于兼容控制台与桌面辅助窗口。

## 页面入口

| 入口 | 实现与用途 |
|---|---|
| `/` / `index.html` | React 主工作台，供 Web 与 Electron 主窗口使用。 |
| `/legacy.html` | Vue 兼容控制台。 |
| 桌面辅助窗口 | 安装、更新、宠物、需求池等独立页面，按入口加载 Vue 实现。 |

主工作台提供项目与会话、流式聊天、推理与工具记录、审批与计划、模型渠道、工具与集成、文件预览和 Git 面板。Electron 通过桌面桥接增加原生终端、文件编辑、进程管理、窗口控制等能力；具体入口与限制见 [Web 工作台说明](web/README.md) 和 [功能对照](web/LEGACY_PARITY.md)。

聊天可选择 Loopra Native、Claude Code 或 Codex。外部引擎需要在后端所在机器安装适配器并完成认证，模型、权限和命令以该引擎提供的能力为准。接入说明见 [Native ACP](../docs/acp-native.md)、[Claude Code](../docs/acp-claude.md) 与 [Codex](../docs/acp-codex.md)。

## 开发环境

- Node.js：`^20.19.0` 或 `>=22.12.0`，以 [package.json](package.json) 的 `engines` 为准。
- pnpm：8 或更高。
- 可访问的 Loopra 后端。模型请求、项目文件与命令执行由后端处理。

在本目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

默认开发地址为 `http://127.0.0.1:3000/`。Vite 将 `/api` 请求代理到 `http://localhost:4567`；可先通过命令行启动对应后端：

```bash
loopra web 4567
```

也可在设置的服务器页面指定后端地址。生产 Web 默认连接当前站点，Electron 主窗口通过桌面桥接获取核心服务的实际端口。连接远端后端时，项目路径和系统操作均指向后端所在机器。

代理与构建配置位于 [vite.config.js](vite.config.js)，服务地址偏好由前端连接逻辑处理。

## 验证与构建

```bash
# React 工作台与协议适配测试（node:test）
pnpm test:web

# Vue 组件测试（Vitest，单次运行）
pnpm test -- --run

# React TypeScript 检查
pnpm typecheck:web

# 类型检查并构建 React 与 Vue 页面入口
pnpm build

# 本地预览构建产物
pnpm preview
```

`pnpm build` 的产物目录为 `dist/renderer`。将其同步到 Java 静态资源的脚本位于 [loopra-release](https://github.com/ezdemo/loopra-release)；单独执行 Maven 不会构建前端源码。

## Electron

```bash
# 开发模式：准备主进程与预加载脚本，并复用或启动 Vite
pnpm dev:electron

# 构建 renderer、主进程与预加载脚本
pnpm build:vite

# 使用 electron-builder 打包当前平台
pnpm package
```

主进程与预加载脚本输出到 `dist/main`。跨平台发行、核心运行时准备和安装包发布由发版仓库组织，`pnpm package` 是本地 Electron 打包入口。

安装后的桌面端使用 `~/.loopra-gui` 保存核心运行时，使用 `~/.loopra` 保存共享配置。核心服务、Java 环境与下载源由启动/更新页面管理。

## 源码结构

```text
loopra-front/
├── web/
│   ├── src/                 # React 主工作台、后端协议适配与样式
│   ├── tests/               # node:test 测试
│   └── README.md            # 主工作台行为与连接说明
├── src/
│   ├── entry.js             # 主入口，按窗口类型选择 React 或 Vue
│   ├── entry-routing.js     # Electron 辅助窗口入口判断
│   ├── main.js              # Vue 入口
│   └── ...                  # Vue 兼容控制台、辅助页面与组件测试
├── electron/                # 主进程、预加载、文件/Git/终端桥接
├── scripts/                 # 开发启动等脚本
├── public/                  # 静态资源与默认连接配置
├── index.html               # 默认入口
├── legacy.html              # Vue 兼容入口
├── vite.config.js           # renderer 开发、代理、测试与构建配置
├── vite.main.config.mjs     # Electron 主进程构建
├── vite.preload.config.mjs  # Electron 预加载构建
└── package.json             # 命令、依赖与 Node.js/pnpm 要求
```

会话隐藏/恢复保存在当前浏览器本地，不等于服务端归档；上下文用量含估算值。语言切换尚未覆盖全部管理页面。原生终端、窗口控制等能力依赖 Electron，不能据此推断普通浏览器也提供相同功能。

应用版本由自动发布流程写入构建文件；依赖以 `package.json` 和 `pnpm-lock.yaml` 为准，本文不维护版本展示表。

## 许可证

[MIT License](../LICENSE)

# Loopra Web 工作台

默认 Web 页面采用 React 18、TypeScript、NextUI 2，源码位于本目录。项目、会话、聊天流、模型渠道、远程模型获取、工具、Git 改动与后台终端直接连接 Loopra API。

## 开发与验证

在 `loopra-front` 目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test:web
pnpm build
```

开发地址为 `http://127.0.0.1:3000/`，默认通过 `/api` 代理连接本机 4567 后端。设置 → 服务器可以更换连接地址。生产 Web 默认使用当前站点地址，支持后端自定义端口；保留原控制台的 `loopra-api-base` 地址偏好，并兼容 `public/config.json` 中的自定义服务地址。新界面的已有地址偏好优先。

构建产物仍输出到 `dist/renderer`，原 `.release/ci-sync-web-assets.sh` 和 `.release/windows_package.ps1` 可继续同步到 Java 静态资源。`index.html` 是新 Web 工作台；`legacy.html` 保留旧 Vue 高级控制台，供暂未迁入的资源编辑、安装等管理操作使用。Electron 的查询参数入口与桌面桥接继续加载原 Vue 页面，两个界面的样式按入口分别加载。

## 界面与行为

- 聊天正文、推理、工具执行、文件改动、选择与审批使用真实 SSE 和历史数据。
- 输入栏支持模型选择、推理强度、权限、附件、文件引用、关联项目与技能。
- 供应商编辑支持远程模型获取，NextUI 弹窗内可搜索、多选、批量添加。添加只更新草稿，点击保存配置后写入后端；已有模型参数保持原值。
- 80%–150% 连续界面缩放同步调整文字、侧栏、按钮、图标和弹层。保留 NextUI 原生交互动效。
- API 密钥由后端保存和脱敏；本地存储仅保存外观、服务地址等偏好，不保存渠道密钥。

后端没有会话归档接口，隐藏/恢复仅影响当前浏览器；高级资源管理使用高级控制台；上下文用量为本地估算；界面语言与提示音属于部分实现的本地偏好。

## 主要入口

- `src/backend.ts`：HTTP/SSE、配置和历史协议适配。
- `src/App.tsx`、`src/useLoopra.ts`：工作区、会话与运行配置。
- `src/components/Composer.tsx`：输入栏与模型选择。
- `src/components/Settings.tsx`：NextUI 设置。
- `src/components/RemoteModelsPicker.tsx`：远程模型选择弹窗。
- `tests/`：聊天块、输入栏、配置、后端协议和迁移回归验证。

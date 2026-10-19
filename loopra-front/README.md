# Web 工作台入口更新

默认 Web 页面已替换为 React + TypeScript + NextUI 工作台，代码位于 `web/`。在本目录执行 `pnpm dev`，访问 `http://127.0.0.1:3000/`；`pnpm test:web` 验证新界面，`pnpm build` 类型检查并构建 Web 与兼容入口。详细说明见 [web/README.md](web/README.md)。需要 Node.js 20.19+ 或 22.12+（建议 Node.js 22/24）。

原 Vue 高级控制台保留在 `/legacy.html`，Electron 子窗口继续使用原 Vue 实现。以下原有文档描述这些兼容页面及桌面功能。

---

# Loopra Frontend

> 智能 AI 代码助手前端界面 - 企业级设计，美观大气

## 📖 项目简介

Loopra Frontend 是 Loopra Java AI Agent 框架的前端界面，采用现代化的企业级设计，提供流畅的用户体验和强大的功能。

## ✨ 核心特性

### 🎨 设计系统
- **企业级设计语言** - 基于现代设计系统，提供一致的视觉体验
- **深色/浅色主题** - 支持主题切换，适应不同环境
- **响应式布局** - 完美适配桌面、平板和移动设备
- **流畅动画** - 精心设计的过渡动画，提升交互体验

### 💬 智能对话
- **实时流式输出** - SSE 流式响应，打字机效果
- **多轮上下文** - 保持对话连贯性
- **思考过程展示** - 可折叠的 AI 思考过程
- **工具调用可视化** - 清晰展示工具调用和执行结果

### 🔧 工具系统
- **丰富的工具集** - 文件操作、代码分析、网络搜索等
- **工具状态管理** - 实时显示工具执行状态
- **参数展示** - 清晰展示工具参数和返回结果
- **风暴断路器** - 防止重复调用死循环

### 📁 会话管理
- **多会话支持** - 创建和管理多个对话会话
- **会话持久化** - 自动保存会话历史
- **会话搜索** - 快速搜索历史会话
- **会话导出** - 导出会话为文本文件

### ⚙️ 灵活配置
- **AI 模型配置** - 支持多种 AI 模型
- **API 端点配置** - 灵活的 API 配置
- **工作区设置** - 自定义工作目录和编辑模式
- **安全设置** - 路径穿越防护、命令白名单等

## 🛠️ 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| **Vue 3** | ^3.4.21 | 前端框架 |
| **Vite** | ^5.1.4 | 构建工具 |
| **Pinia** | ^2.1.7 | 状态管理 |
| **Vue Router** | ^4.3.0 | 路由管理 |
| **Axios** | ^1.6.7 | HTTP 客户端 |
| **CSS3** | - | 样式和动画 |

## 📁 项目结构

```
loopra-front/
├── public/                    # 静态资源
│   ├── favicon.svg           # 网站图标
│   └── ...
├── src/
│   ├── assets/               # 资源文件
│   │   └── styles/
│   │       └── main.css      # 全局样式和设计系统
│   ├── components/           # 组件目录
│   │   ├── Composer.vue      # 输入组件
│   │   ├── StatusBar.vue     # 状态栏组件
│   │   ├── TabBar.vue        # 标签栏组件
│   │   └── TitleBar.vue      # 标题栏组件
│   ├── composables/          # 组合式函数
│   │   └── useTerminal.js    # 终端功能
│   ├── router/               # 路由配置
│   │   └── index.js
│   ├── services/             # API 服务
│   │   └── api.js
│   ├── stores/               # 状态管理
│   │   └── app.js
│   ├── utils/                # 工具函数
│   │   └── helpers.js
│   ├── views/                # 页面视图
│   │   ├── Home.vue          # 首页
│   │   ├── Chat.vue          # 对话页面
│   │   ├── Tools.vue         # 工具页面
│   │   ├── Sessions.vue      # 会话页面
│   │   ├── Settings.vue      # 设置页面
│   │   ├── Help.vue          # 帮助页面
│   │   └── NotFound.vue      # 404页面
│   ├── App.vue               # 根组件
│   └── main.js               # 入口文件
├── index.html                # HTML 入口
├── package.json              # 项目配置
├── vite.config.js            # Vite 配置
└── README.md                 # 项目文档
```

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18.0.0
- **pnpm** >= 8.0.0 (推荐) 或 npm/yarn

### 安装依赖

```bash
# 使用 pnpm (推荐)
pnpm install

# 或使用 npm
npm install

# 或使用 yarn
yarn install
```

### 开发模式

```bash
# 启动开发服务器
pnpm dev

# 或
npm run dev
```

访问 http://localhost:3000

### 构建生产版本

```bash
# 构建生产版本
pnpm build

# 或
npm run build
```

构建产物将输出到 `dist/` 目录。

### 预览生产版本

```bash
# 预览生产版本
pnpm preview

# 或
npm run preview
```

## ⚙️ 配置说明

### API 代理配置

在 `vite.config.js` 中配置了 API 代理：

```javascript
server: {
  port: 3000,
  proxy: {
    '/api': {
      target: 'http://localhost:8097',
      changeOrigin: true,
      ws: true
    }
  }
}
```

确保 Loopra 后端服务运行在 `http://localhost:8097`。

### 环境变量

创建 `.env` 文件：

```env
VITE_API_BASE_URL=http://localhost:8097
VITE_APP_TITLE=Loopra
VITE_APP_VERSION=1.0.0
```

## 📱 页面说明

### 首页 (`/`)
- 品牌展示和功能介绍
- 快速开始指南
- 技术栈展示
- 行动号召按钮

### 对话页面 (`/chat`)
- 与 AI 助手实时对话
- 支持流式输出和打字机效果
- 工具调用可视化展示
- 思考过程可折叠显示
- 文件附件支持

### 工具页面 (`/tools`)
- 工具列表展示和搜索
- 工具详情查看
- 工具分类筛选
- 使用示例和参数说明

### 会话页面 (`/sessions`)
- 历史会话列表
- 会话统计信息
- 会话加载、导出和删除
- 会话搜索和分页

### 设置页面 (`/settings`)
- **基本设置** - 语言、主题、字体大小、动画效果
- **AI 设置** - API 配置、模型选择、推理强度、温度
- **工作区设置** - 工作目录、编辑模式、排除目录
- **安全设置** - 风暴断路器、路径穿越防护、命令白名单
- **高级设置** - 调试模式、上下文折叠、消息自愈

### 帮助页面 (`/help`)
- 快速入门指南
- 命令参考
- 工具列表
- 配置说明
- 故障排除
- API 文档
- 更新日志

## 🎯 命令说明

在聊天输入框中可以使用以下斜杠命令：

| 命令 | 描述 | 示例 |
|------|------|------|
| `/help` | 显示帮助信息 | `/help` |
| `/new` | 开启新会话 | `/new` |
| `/plan` | 进入计划模式 | `/plan` |
| `/execute` | 退出计划模式 | `/execute` |
| `/compact` | 折叠历史消息 | `/compact` |
| `/retry` | 撤回最后一条消息并重试 | `/retry` |
| `/rewind N` | 回退到第N轮对话 | `/rewind 5` |
| `/sessions` | 列出历史会话 | `/sessions` |
| `/load N` | 加载指定会话 | `/load 3` |
| `/init` | 自动分析项目生成文档 | `/init` |
| `/hitl` | 切换 HITL 模式 | `/hitl` |
| `/agree` | 批准 HITL 待执行的工具调用 | `/agree` |
| `/deny` | 拒绝 HITL 待执行的工具调用 | `/deny` |
| `/exit` | 退出系统 | `/exit` |

## 🎨 主题定制

项目支持深色和浅色主题，可以通过以下方式切换：

1. **设置页面** - 在设置页面中选择主题
2. **快捷键** - 使用快捷键切换
3. **系统偏好** - 自动跟随系统主题

### 主题变量

项目使用 CSS 变量系统，可以在 `src/assets/styles/main.css` 中自定义：

```css
:root {
  /* 品牌色 */
  --brand-primary: #6366f1;
  --brand-secondary: #0ea5e9;
  
  /* 背景色 */
  --bg: #ffffff;
  --bg-secondary: #f8fafc;
  
  /* 文字颜色 */
  --fg: #0f172a;
  --fg-secondary: #334155;
  
  /* 更多变量... */
}
```

## ⌨️ 快捷键

| 快捷键 | 描述 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Ctrl+K` | 聚焦搜索 |
| `Ctrl+N` | 新建对话 |
| `Ctrl+B` | 切换侧边栏 |
| `Escape` | 关闭弹窗 |

## 🔧 开发指南

### 添加新页面

1. 在 `src/views/` 目录下创建新的 `.vue` 文件
2. 在 `src/router/index.js` 中添加路由配置
3. 在 `src/App.vue` 的导航菜单中添加链接

### 添加新组件

1. 在 `src/components/` 目录下创建新的 `.vue` 文件
2. 在需要使用的页面中导入组件
3. 遵循组件命名规范

### 状态管理

使用 Pinia 进行状态管理：

```javascript
// 创建新的 store
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useMyStore = defineStore('my', () => {
  // 状态
  const myState = ref(null)
  
  // 计算属性
  const myComputed = computed(() => myState.value)
  
  // 方法
  const updateState = (newValue) => {
    myState.value = newValue
  }
  
  return {
    myState,
    myComputed,
    updateState
  }
})
```

### API 调用

```javascript
import { chatAPI, sessionsAPI } from '@/services/api'

// 发送消息
const response = await chatAPI.sendMessage('Hello')

// 流式聊天
const stream = chatAPI.sendMessageStream(
  'Hello',
  (data) => console.log('Message:', data),
  () => console.log('Done'),
  (error) => console.error('Error:', error)
)
```

## 📊 性能优化

### 代码分割
- 路由级别的代码分割
- 组件懒加载
- 第三方库分离

### 资源优化
- 图片压缩和懒加载
- CSS 和 JavaScript 压缩
- 字体优化

### 缓存策略
- 静态资源缓存
- API 响应缓存
- 本地存储优化

## 🧪 测试

```bash
# 运行测试
pnpm test

# 运行测试 UI
pnpm test:ui

# 运行测试覆盖率
pnpm test:coverage
```

## 📦 构建部署

### 开发环境

```bash
pnpm dev
```

### 生产环境

```bash
# 构建
pnpm build

# 预览
pnpm preview
```

### Docker 部署

```dockerfile
FROM node:18-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

## 🌐 浏览器支持

| 浏览器 | 版本 |
|--------|------|
| Chrome | 80+ |
| Firefox | 75+ |
| Safari | 13+ |
| Edge | 80+ |

## 📄 许可证

MIT License

## 🤝 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 📞 联系方式

- 项目地址: https://gitee.com/ezdemo/loopra
- 问题反馈: https://gitee.com/ezdemo/loopra/issues

## 🙏 致谢

感谢所有为这个项目做出贡献的人！

---

**Loopra** - 智能 AI 代码助手，让编程更高效！

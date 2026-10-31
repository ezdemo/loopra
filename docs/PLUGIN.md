# 插件

插件是一个 ES 模块，由 [moejs](https://github.com/MoeForge/moejs) 执行。从侧栏「技能与插件」点击「添加 → 安装插件」，填写来源即可安装。主仓库只保留内置 `plugins/web` 联网工具，名字仍然是 `web`。聊天猫娘、每日回顾、OpenAPI 和上下文透视已迁到 [loopra-plugins](https://github.com/ezdemo/loopra-plugins)，可在「发现」中筛选「插件」并安装。模块可以导出工具和对话钩子，也可以使用 moejs 的 [Web API](https://github.com/MoeForge/moejs/blob/main/docs/guide.zh_CN.md#web-api) 和 [Node.js 模块](https://github.com/MoeForge/moejs/blob/main/docs/guide.zh_CN.md#nodejs-%E6%A8%A1%E5%9D%97)。

安装后的文件在 `~/.loopra/plugins/packages/<id>`，清单是 `~/.loopra/plugins/installed.json`。设置了 `LOOPRA_JAVA_BACKEND_URL` 时，本进程不加载这些插件。

## 安装来源

来源可以是：

- `left-pad`、`left-pad@1.2.3`、`npm:@scope/pkg@1.2.3`
- `github:owner/repo`、`owner/repo#ref`、`https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/<ref>/<subdir>`
- 本地目录、`.tgz` / `.tar.gz`，或单个 `.js` / `.ts` 文件。可以写绝对路径、`./` 相对路径，或 `file:` 地址

不接受 `.jar`，以及不是 github.com 的 http(s) 地址。GitHub 没写分支时先试 `main`，再试 `master`。本地目录会原样复制后再安装其中的生产依赖。单个模块文件会放进一份临时的 `package.json`。

插件 id 会去掉开头的 `@`，把 `/` 换成 `__`，再把其余非字母数字字符收成 `_`。`demo-plugin` 的工具 `greet` 公开名称是 `demo_plugin__greet`。`@scope/pkg` 的 id 是 `scope_pkg`。

## GitHub 插件源

技能与插件 → 发现 → 插件，可以从 GitHub 仓库浏览并安装多个插件。默认源是 `https://github.com/ezdemo/loopra-plugins`。在「管理源」中添加或移除公开仓库，用下拉框切换来源。在「我的内容 → 插件」中启停、设置或卸载；发现页已安装的外部插件也可以直接卸载，确认后按钮恢复「安装」。安装、卸载只更新安装状态，保留发现列表和滚动位置。内置插件只能停用。移除源只取消订阅，已经安装的插件继续保留。

仓库不需要额外的索引文件，推荐按下面的目录组织：

```text
loopra-plugins/
  README.md
  plugins/
    hello/
      package.json
      plugin.js
    another-plugin/
      package.json
      plugin.ts
      ui/
        index.html
```

每个插件的 `package.json` 需要一个唯一的 `name`，可填写 `description`、`version`，并用 `loopra` 指定入口。列表从这些字段读取信息，不执行插件代码。扫描跳过隐藏目录、`node_modules` 和已识别插件的子目录；入口规则与单独安装一致，也支持根目录就是一个插件的仓库。同一源中生成相同 id 的插件会报错。

```json
{
  "name": "hello",
  "version": "1.0.0",
  "description": "打招呼示例",
  "loopra": "./plugin.js"
}
```

```js
export function greet(args) {
  return { text: "你好，" + (args.name || "世界") };
}
```

可以将 [examples/plugin-source](../examples/plugin-source/) 的内容复制到新仓库后提交。空仓库需要先创建一次提交，添加插件后刷新列表即可。仓库下载和解压沿用插件安装限制：压缩包不超过 32 MiB，解压后不超过 64 MiB、4000 个文件，单文件不超过 8 MiB。

插件源保存在 `~/.loopra/plugins/sources.json`，移除默认源后重启也不会自动加回。支持 `owner/repo#ref` 指定分支或标签，未指定时依次尝试 `main`、`master`。限定子目录时可使用 `https://github.com/owner/repo/tree/main/plugins`；分支名包含 `/` 时使用 `https://github.com/owner/repo?path=plugins#feature/plugins`，安装时生成的来源也使用这一格式。

| 接口 | 用途 |
| --- | --- |
| `GET /api/plugins/sources` | 列出已添加的插件源 |
| `POST /api/plugins/sources`，`{ "source": "https://github.com/owner/repo" }` | 添加源，重复添加会去重 |
| `POST /api/plugins/sources/remove`，`{ "source": "https://github.com/owner/repo" }` | 移除源，保留已安装插件 |
| `GET /api/plugins/catalog?source=<编码后的仓库地址>` | 浏览源中的插件 |
| `POST /api/plugins/install`，`{ "source": "<列表项的 source>" }` | 安装选中的插件 |
| `POST /api/plugins/<id>/remove` | 卸载并移除插件文件、配置、数据和工具 |

## 内置插件

`plugins/` 目录里，`package.json` 写了名字的插件是内置插件。程序启动时安装；目录还在、来源没变时，按当前文件更新。

内置插件可以停用，不能卸载。设置页上来源显示「内置」，没有卸载按钮。接口里这项是 `builtin: true`，`POST /api/plugins/<id>/remove` 会拒绝。

内置插件的 `loopra.defaultEnabled` 只在第一次安装时生效。`false` 表示默认关闭，不写或写 `true` 表示默认开启。用户之后的开关会留下来，以后更新不会改回去。`plugins/web` 默认开启；用户主动安装的外部插件在安装后启用。

插件从 `plugins/` 里去掉之后，已经装上的那份不再是内置，可以卸载。同名但来源不是这个目录的插件保持原样，也不会变成内置。

聊天猫娘、每日回顾、OpenAPI 和上下文透视从内置迁出时，已安装副本的文件、配置、数据和启停状态都会保留；来源改为 `loopra-plugins` 中对应的目录，取消内置标记后支持卸载。新安装的 Loopra 不再自动安装这四个插件。

这四个插件的页面测试在插件仓库中运行。主仓库保留宿主集成测试；将 `loopra-plugins` 克隆到主仓库同一级目录，或设置 `LOOPRA_PLUGIN_SOURCE_DIR` 指向插件仓库根目录，即可运行。CI 会检出插件仓库运行这些集成测试。

## 入口

按这个顺序找入口：

1. `package.json` 的 `loopra`：字符串，或 `{ "plugin": "./plugin.ts" }`、`{ "main": "./plugin.js" }`。对象里还可以写 `defaultEnabled`、`icon`、`ui.settings`、`ui.sidebar`、`ui.menu`，以及下面的技能、子代理和定时任务
2. `module`、`main`
3. `plugin.ts`、`plugin.mts`、`plugin.js`、`plugin.mjs`
4. `index.ts`、`index.mts`、`index.js`、`index.mjs`
5. `src/plugin.ts`、`src/plugin.js`、`src/index.ts`、`src/index.js`

可以 `import` 相对路径，以及包里的生产依赖。`.js` 可以解析到同名的 `.ts`。依赖只安装 `dependencies`，不跑生命周期脚本，也不接受 `file:`、`workspace:`、`git+` 这类版本。

## 工具

导出的函数会变成工具。参数和返回值都是一个对象。返回字符串时，宿主把它当成 `{ text }`。

```js
export function greet(args) {
  return { text: "hello " + (args.name || "world") };
}
```

也可以用清单分发：

```js
export function tools() {
  return [{
    name: "greet",
    description: "打招呼",
    readOnly: true,
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "名字" } },
      required: ["name"]
    }
  }];
}
export function call(input) {
  return { text: "hello " + (input.args.name || "world") };
}
```

`export const meta = { displayName, description }` 或 `{ name, remark }` 用来显示名称和说明。`readOnly: true` 的工具自动放行，其他工具仍走现有审批。`chat: true` 的工具可以在纯聊天里使用；不写则只在项目里可用。两种写法里，只有 `tools()` 返回的清单能带上 `chat`。

`tools()` 的条目还可以设置 `expose`，指定模型看到的公开工具名，例如 OpenAPI 使用 `expose: "search_apis"`。未设置时仍使用 `<插件 id>__<工具名>`。`expose` 使用工具名字符规则，多个插件共享公开命名空间，应避免重复命名；`call(input).name` 仍是条目原来的 `name`。

`tools`、`call`、`meta`、`default`、`plugin`、`onRequest`，以及下面的钩子名，不会注册成工具。只有钩子或 `onRequest`、没有工具的模块也可以加载。

函数可以是 `async`。宿主会等返回的 Promise 完成，再把结果交给对话。

## 钩子

钩子和工具可以写在同一个模块里，也可以写在 `export default` 上。多个插件串行执行，前一个的返回值交给下一个。可在 `meta.hookPriority` 中分别指定各个钩子的整数优先级：数值小的先执行，默认 `0`，相同优先级保留安装顺序。某个插件抛错时跳过它，后面的继续。子代理用同一套钩子，并带上 `parentSessionId`。

```js
export const meta = {
  displayName: "我的插件",
  hookPriority: { systemPrompt: -10, llmRequest: 20 }
};
```

`systemPrompt` 的多个 `append` 会按执行顺序累加，每个插件的 `input.text` 都包含此前的追加内容。返回 `text` 表示明确替换当前全文（包括此前的追加），同次返回的 `append` 再接到替换结果后面。其他替换字段仍由后执行的插件覆盖；优先级只控制同名钩子的顺序，`llmRequest` 在全部 `systemPrompt` 完成后执行，`llmRequestSent` 最后只读观察实际发送内容。

只补充规则时返回新增片段即可，不要把 `input.text` 再放进 `append`，否则会重复全文。需要在 `llmRequest` 中补充系统内容时，应从 `input.system` 继续追加，保留此前插件的结果：

```js
export function systemPrompt(input) {
  if (input.app !== "__loopra_chat__") return {};
  return { append: "\n仅用于纯聊天的补充规则。" };
}

export function llmRequest(input) {
  return { system: (input.system || "") + "\n本次请求的补充信息。" };
}
```

优先级写在入口模块的 `meta` 中，不是 `package.json`；未声明或不是有效整数的单项按 `0` 处理。不同钩子的优先级互不影响。以上提示词合并和优先级由宿主实现，旧版宿主需要更新并重启 Loopra，现有插件无需重装。聊天猫娘、OpenAPI 和上下文透视可同时启用：人设、接口规则及透镜固定内容依次保留。

每次调用都会带上当时能确定的 `invocationId`、`sessionId`、`app`、`agent`，以及这个插件自己的 `config`。`config` 就是设置页保存的对象，没有保存过时是 `{}`。

| 钩子 | 可以返回 | 作用 |
| --- | --- | --- |
| `turnBefore` | `{ message?, context?, cancel?, reason? }` | 改用户消息，或用 `cancel: true` 结束这一轮。默认说明是「这一轮已取消」 |
| `systemPrompt` | `{ text?, append? }` | `text` 替换已组装的系统提示词，`append` 接在后面 |
| `llmRequest` | `{ system?, messages?, temperature?, maxOutputTokens?, dropTools?, foldToolResults?, body? }` | 改这一次模型调用。`body` 替换即将 POST 的 JSON，HTTP 仍由宿主发送 |
| `llmRequestSent` | 忽略 | 在适配器完成序列化、发送 HTTP 前只读观察最终 `body`、`requestBytes`、`protocol` 和请求身份。每个观察者独立接收，不采集认证请求头 |
| `llmResponse` | `{ text?, thought?, toolCalls? }` | 改模型最终回复。流式过程中的片段不会逐个改 |
| `toolBefore` | `{ decision?, args?, reason? }` | `allow` 可改参数，审批和路径检查仍然生效；`deny` 直接拒绝；`ask` 进入现有审批 |
| `toolAfter` | `{ result?, error? }` | 改工具结果，或把失败写成说明 |
| `compact` | `{ summary?, keep?, drop? }` | 改压缩摘要。`keep` 是字符串或字符串数组。`drop: true` 丢掉这次摘要 |
| `turnAfter` | 忽略 | 本轮结束时的清理。`status` 是 `completed`、`cancelled` 或 `error` |

`toolBefore` 在用户批准后会再进一次，这时 `approved` 为 `true`。`llmRequest.messages` 的每一项是 `{ role, text, parts }`，`parts` 里可以有 `text`、`thought`、`functionCall`、`functionResponse`。

`llmRequest` 还可以返回 `foldToolResults: ["工具调用 id"]`，只折叠本次请求中对应的工具响应正文，保留响应名称、调用 id 和其余消息部分。宿主按写入时复制处理，历史会话内容不变。`llmRequestSent.foldableCalls` 是本次请求中可按 id 折叠的调用；没有稳定 id 的结果不提供折叠操作。

## 网络

宿主安装了 moejs 的 Web API，没有主机名白名单。`fetch` 可以访问本进程能到达的任何 `http:` 或 `https:` 地址，包括本机、内网和链路本地地址。`data:`、`blob:` 和 `file:` 会拒绝，这是这个 Web API 自己的范围。

可用的全局对象包括 `fetch`、`Headers`、`Request`、`Response`、`URL`、`URLSearchParams`、`AbortController`、`AbortSignal`、`ReadableStream`、`WritableStream`、`TransformStream`，以及 `performance.now()`。不提供 `Blob`、`File` 和 `FormData`。

```js
export async function page(args) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: args.q })
  });
  const text = await response.text();
  return { text, status: response.status, ok: response.ok };
}
```

要读正文就 `await response.text()`、`json()`、`arrayBuffer()` 或 `bytes()`。一次调用最多等 10 分钟，和这份客户端超时一致。用户停下这一轮时，进行中的 `fetch` 会取消。

## 文件

宿主安装了 `node:fs`、`node:fs/promises` 和 `node:buffer`，也可以用裸说明符 `fs`、`fs/promises`、`buffer` 导入。全局有 `Buffer`。文件系统可以写，没有额外的路径白名单。

```js
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export function save(args) {
  writeFileSync(args.path, args.text);
  return { text: readFileSync(args.path, "utf8") };
}

export async function load(args) {
  return { text: await readFile(args.path, "utf8") };
}
```

同步、回调和 Promise 三种形式都可以用。Promise 形式和 `fetch` 一样，由宿主的事件循环等它完成。

路径按 moejs 的 `node:fs` 解析：

- 在 Linux 和 macOS 上，根目录就是 `/`，绝对路径就是本机路径。
- 在 Windows 上，这个模块只能覆盖一个盘。宿主把系统盘挂在 `/`。`C:\Users\a\b.txt` 写成 `/Users/a/b.txt`。系统盘以外的路径不在这棵目录里。
- 相对路径从 Loopra 进程的当前工作目录算起。
- 离开这棵目录的 `..` 和符号链接会被这个模块拒绝。根目录里面的链接可以照常使用。

`fs.writeFileSync` 直接写本机文件，不经过对话里的路径检查和审批。标记成非只读的插件工具，在被模型调用时仍走审批。

## 设置页

`loopra` 写成对象时可以声明一个设置页。[chat-neko](https://github.com/ezdemo/loopra-plugins/tree/main/plugins/chat-neko) 带了一份示例。

```json
{
  "loopra": {
    "plugin": "./plugin.js",
    "ui": { "settings": "./ui/index.html" }
  }
}
```

宿主在插件卡片上打开它，放进 iframe。`sandbox` 不带 `allow-same-origin`，页面读不到访问密钥和 `localStorage`。地址里也不放访问密钥。打开前宿主会给这个插件单独发一个 HttpOnly cookie，只在 `/api/plugins/<id>/ui` 下有效，并返回页面路径 `/plugins/<id>/ui/t/<票据>/`。沙箱页的子资源带不上这枚 cookie，所以样式表、脚本、图片和字体走这条带票据的路径。票据只够读取这个插件的页面文件，一小时后失效。

能取到的文件只限入口所在的目录，例如 `./ui/index.html` 只能再取 `ui/` 里面的文件。允许的类型是 HTML、CSS、JS、常见图片和字体。`..`、符号链接和其他类型都会拒绝。页面自己的 `fetch` 连不上 Loopra 接口。`_loopra/bridge.js` 是宿主桥，不从插件目录里取。

页面可以引用同目录的样式表和脚本，也可以把样式和脚本写在 HTML 里。宿主桥会垫一层没有优先级的基础样式，没写样式的标题、按钮、输入框和表格跟主窗口一致。打开后宿主发：

```js
{ type: "loopra", op: "ready", plugin: { id, name }, theme }
```

`theme` 里有 `dark`，以及不带 `--` 的变量：`surface`、`sidebar`、`soft`、`text`、`secondary`、`muted`、`line`、`blue`、`accent`、`accent-soft`、`success`、`warning`、`danger`、圆角、阴影，还有 `font` 和 `code`。桥把它们写成页面上的同名变量，字体写到 `--loopra-font` 和 `--loopra-code`。配置是一个 JSON 对象，最大 64 KiB，存在 `~/.loopra/plugins/ui-config/<id>.json`。重装插件不会清掉它，卸载会删掉。

```html
<link rel="stylesheet" href="style.css">
<script src="_loopra/bridge.js"></script>
<script src="app.js"></script>
```

```js
await loopra.ready;
const value = await loopra.config.get();
await loopra.config.set({ nickname: "主人" });
loopra.onTheme(theme => {});
```

```js
parent.postMessage({ type: "loopra", op: "config:get", id: "1" }, "*");
parent.postMessage({ type: "loopra", op: "config:set", id: "2", value: { nickname: "主人" } }, "*");
```

宿主只接受来自这个 iframe 的消息，并用 `{ type: "loopra", op: "config", id, value }` 或 `error` 回答。设置页不能调用插件工具。停用的插件仍然可以打开设置页。

### 页面后端

任何插件都可以导出 `onRequest(input)`，也可以写在 `export default` 上。页面用统一桥调用自己的后端，不需要改 Loopra 的控制器：

```js
// plugin.js — 运行在后端，可以使用 fetch、node:fs 和随包依赖。
export async function onRequest({ action, value, config, context }) {
  if (action !== "checklist") throw new Error("不支持的操作");
  return { topic: value.topic || config.focus || "当前改动", workspace: context.workspaceDir };
}
```

```js
// ui/app.js — 运行在沙箱页面。
await loopra.ready;
const result = await loopra.request("checklist", { topic: "失败路径" });
```

`input` 包含 `action`、`value`（JSON 对象）、插件自己的最新 `config` 和工作台选择的 `context`。处理函数可以返回 JSON 值，抛出的错误会让页面的 Promise reject。只有 `onRequest` 的模块也可以安装；它不会被注册为模型工具。只有已启用且成功加载的插件可被调用。

页面发送 `{type:"loopra", op:"service:request", id, action, value}`，收到 `{type:"loopra", op:"service:result", id, value, error?}`。工作台固定使用当前 iframe 的插件 id 请求 `POST /api/plugins/<id>/request`，并附上当前上下文；页面不能指定其他插件身份，访问密钥不会发给 iframe。单次请求体不超过 64 KiB，操作名不超过 128 字节，处理时间最多 30 秒，离开页面或重试会取消请求。执行中的页面请求被取消或超时后，宿主会重新加载该插件后端，清掉遗留的异步任务；模块内存状态随之重置，持久数据应存到文件或配置中。

页面操作由插件显式分发。宿主不会把动作名称自动映射到工具，不能通过这条通道直接调用模型工具或跳过其审批。插件作者应只开放页面需要的动作；页面后端和现有插件工具一样拥有文件与网络能力，`context` 只代表用户选择，不是文件权限边界。

### 上下文和页面故障

`await loopra.ready` 后可以读取 `loopra.context`，包括可用的 `workspaceHash`、`workspaceDir`、`sessionId`、`filePath`。这里只传项目、会话和当前文件的位置，不传会话正文或访问密钥。没有选择的字段会省略。设置页、设置菜单和侧栏使用同一份上下文。选择变化不会重载页面，使用 `loopra.onContext(context => {})` 监听；后端请求始终携带发起时的当前选择。

桥会报告页面脚本错误和未处理的 Promise rejection。10 秒内未完成握手的页面显示错误和「重试」，重试会重新打开页面并取消旧请求；其他页面继续工作。后端的 `console.log/info/warn/error/debug` 会按插件 id 写入宿主日志，单条正文最多 8 KiB；调试日志沿用 `LOOPRA_DEBUG`。不要在日志里输出认证信息。

### 声明宿主服务

页面里的 `loopra.request` 调用自己的 `onRequest`。后端如果需要复用宿主能力，在 `package.json` 声明服务名，再用后端专用的 `loopra.services.request(service, action, value)`：

```json
{ "loopra": { "plugin": "./plugin.js", "services": ["openapi"] } }
```

```js
export function onRequest({ action, value }) {
  if (!["sources", "save", "refresh", "remove", "search", "detail"].includes(action)) {
    throw new Error("页面不支持此操作");
  }
  return loopra.services.request("openapi", action, value);
}
```

当前宿主提供 `openapi` 和 `sessions`。`openapi` 支持文档下载、JSON / YAML 解析、缓存、源认证、搜索、接口详情与调用，沿用 `~/.loopra/openapi-sources.json` 和原有缓存；`sessions` 提供只读会话历史，参数见[右侧面板](#右侧面板)。服务按声明提供，不按插件 id 特判，第三方插件同样可以声明使用。未声明或宿主未提供的服务会报错；iframe 不能直接调用宿主服务，也不能传任意宿主 API 路径。

[OpenAPI 插件](https://github.com/ezdemo/loopra-plugins/tree/main/plugins/openapi) 是完整示例：插件设置页和「工具与集成 → OpenAPI」设置菜单复用同一份页面；UI 使用统一桥；`onRequest` 只开放源管理、搜索和详情；`call_api` 工具在后端调用同一服务的 `call`，仍经过现有工具审批。文档解析和认证实现在 Go 宿主服务中，页面和操作分发属于插件。

iframe 没有 `allow-forms`。页面的保存、搜索等按钮应通过点击或键盘事件发消息，不依赖浏览器原生表单提交。

## 侧栏入口

`ui.sidebar` 在侧栏「定时任务」下面加一个入口。点开后主区域显示页面，沙箱、cookie 和消息跟设置页一样。cookie 的 Path 是 `/api/plugins/<id>/sidebar`。

可以写路径，也可以写标题、图标和路径。没写标题时用插件显示名。没写图标时用插件自己的 `icon`。样式和脚本跟设置页一样，可以写在 HTML 里，也可以放在入口目录的文件里。停用或卸载后，侧栏入口和设置菜单都会去掉。插件卡片上的设置页还可以打开。[chat-neko](https://github.com/ezdemo/loopra-plugins/tree/main/plugins/chat-neko) 只挂设置页，用来改纯聊天里的称呼。[daily-review](https://github.com/ezdemo/loopra-plugins/tree/main/plugins/daily-review) 同时挂了设置页、侧栏和带两个子菜单的设置菜单。

```json
"icon": "./ui/icon.svg",
"ui": {
  "settings": "./ui/index.html",
  "sidebar": { "title": "记事", "icon": "./ui/icon.svg", "page": "./ui/index.html" }
}
```

## 右侧面板

`ui.panel` 在右侧「文件 / Git / 能力」后面增加一个插件页签，适合需要和当前会话并排使用的工具。支持路径字符串，或标题、图标和页面对象：

纯聊天同样可以通过右上角开关打开右侧栏，显示「能力」和已启用插件的面板，隐藏文件与 Git。插件仍通过 `loopra.context` 接收当前纯聊天会话的上下文。

```json
{
  "loopra": {
    "plugin": "./plugin.js",
    "icon": "search",
    "ui": { "panel": { "title": "透镜", "page": "./ui/index.html" } }
  }
}
```

标题和图标省略时沿用插件名称与图标。页面通过 `/api/plugins/<id>/panel/open` 打开，使用独立的 `/panel/t/<票据>/` 路径，复用设置页的沙箱、主题、配置、上下文和 `loopra.request()`。页签选择按会话保存；页签过多可横向滚动；刷新按钮重新打开当前插件页。停用或卸载后入口移除；当前页已不可用时退回有效页签，没有其他已选页时项目退回文件页、纯聊天退回能力页。

[上下文透视插件](https://github.com/ezdemo/loopra-plugins/tree/main/plugins/context-lens) 使用这个插入点，不占用左侧主导航。它通过 `llmRequestSent` 记录 Loopra Native 的实际发送前快照，覆盖 Chat Completions、Responses 和 Anthropic。最近 16 次请求、约 6 MiB 的记录会原子写入插件数据目录，重启、重新加载和升级插件后仍可查看，超长段落明确标为截断。清空快照只删除透镜记录，不改动会话日志。

当前会话没有请求快照时，透镜通过只读 `sessions` 宿主服务展示已保存的用户消息、助手消息、思考记录、工具调用与结果；外部 ACP Agent 的历史会话也支持。历史视图明确标为「会话历史」，不补入当前的系统提示或工具定义，不声称还原当时的完整请求。读取保留最近 1200 行、最多约 3 MiB，超出时标明截断。历史工具结果不能直接折叠；外部 Agent 隐藏仅对 Native 生效的固定操作。

插件后端可在 `loopra.services` 中声明 `"sessions"`，然后调用 `loopra.services.request("sessions", "history", { workspaceHash, sessionName, revision? })` 读取已登记项目的可见会话记录，传入相同 `revision` 时返回 `unchanged: true`。这是读取能力，不会运行 Agent 或工具。后端的 `loopra.dataDir` 是独立于插件包的可写数据目录，可使用 `node:fs` 保存数据，升级时保留、卸载时删除；此路径不传给 iframe。

透镜可以按类别筛选、搜索并查看原文，工具结果会关联实际调用名称。界面 token 数按 UTF-8 文本字节数约算，不含媒体和协议开销；媒体不保留原始二进制数据。固定内容和折叠设置按项目与会话保存在插件配置中，下一次请求生效，不会自动重新发送消息。固定内容每个会话最多 2000 字符，最多折叠 64 条结果，配置保留最近 12 段会话。

图标可以是包内的 SVG、PNG、JPG、WebP 或 GIF，也可以是 Lucide 图标名，例如 `cat`、`message-circle`。图片不超过 256 KiB。插件卡片用 `loopra.icon`。菜单省略 `icon` 时继承插件图标，显式设置 `icon: false` 时不显示图标；例如 OpenAPI 的 `ui.menu.icon` 为 `false`，卡片仍使用自己的 `braces` 图标。

## 设置菜单

`ui.menu` 默认加在设置窗口左侧、内置分类的下面。可通过 `category` 指定挂到现有分类下，例如 `"category": "工具与集成"`。支持偏好设置、模型服务、智能体、工具与集成、工作区与数据、连接与帮助；未填写或分类不存在时保留独立入口。挂载后，搜索、面包屑和窄屏页面导航使用所属分类。带子页面的菜单使用每项声明的 `title`，不添加插件名前缀。每项可独立设置 `icon`：图标名或包内图片路径表示展示该图标，`false` 表示隐藏，省略时继承插件卡片图标，父菜单的图标开关不影响子菜单。只有 `page` 时，点父菜单就打开页面。写了 `children` 时，父菜单展开子菜单，每个子菜单有自己的页面。父子都可以带 `icon`。子菜单最多 12 个。`id` 可省略，省略时按顺序用 `1`、`2`。

cookie 的 Path 是 `/api/plugins/<id>/menu`。页面地址是 `/menu/`，有子菜单时是 `/menu/<id>/`。

```json
"menu": {
  "title": "记事",
  "icon": "./ui/icon.svg",
  "children": [
    { "id": "nickname", "title": "称呼", "icon": "message-circle", "page": "./ui/index.html" }
  ]
}
```

例如，同一个插件可以在「工具与集成」下声明两个独立入口，分别设置名称、页面和图标：

```json
"menu": {
  "title": "业务接口",
  "category": "工具与集成",
  "children": [
    { "id": "orders", "title": "订单查询", "icon": "search", "page": "./ui/orders.html" },
    { "id": "settings", "title": "接口设置", "icon": false, "page": "./ui/settings.html" }
  ]
}
```

## 技能、子代理、定时任务

已启用的插件可以各声明一条。它们出现在现有的技能、子代理和定时任务列表里。停用或卸载后一起消失，也不会写进用户自己的技能目录、`sub-agents.json` 或某个项目的定时任务文件。[daily-review](https://github.com/ezdemo/loopra-plugins/tree/main/plugins/daily-review) 把这三项和设置页、侧栏、菜单、只读工具放在同一个插件里。

```json
"skill": "./SKILL.md",
"subagent": {
  "name": "回顾",
  "description": "按回顾清单做只读检查",
  "readOnly": true,
  "file": "./AGENT.md"
},
"schedule": {
  "name": "每日回顾",
  "message": "请用几句话回顾今天。",
  "cron": "0 0 9 * * ?"
}
```

`skill` 也可以写成 `{ "file": "./SKILL.md" }`。文件名必须是 `SKILL.md`，可以放在子目录里。开头的 frontmatter 提供 `name` 和 `description`，缺了就用插件自己的名称和说明。技能标识是 `@plugin-skills/<插件 id>`，模型用 `skillread` 读取。技能页上标成插件，不能从那里卸载。

`subagent` 的说明可以改成 `"file": "./AGENT.md"`。角色 id 固定是 `plugin-<插件 id>`。它会出现在子代理列表里，不能在那里编辑或删除。`readOnly` 省略时是只读。

`schedule` 用 6 字段 `cron`，或者用 `intervalSec`（至少 60 秒）。两者都写时以 cron 为准。到点后在纯聊天里新建一次会话并发送 `message`。定时任务页上标成插件，不能改内容或暂停；停用插件就会停。`POST /api/plugins/schedules/<id>/run` 可以立刻跑一次。

## 边界

插件跑在 Loopra 进程里，文件和网络使用这个进程自己的操作系统权限。

这些限制还在：

- 插件自己的 `import` 不能越出插件目录，也不能导入 `http:` 地址。
- 没有安装 `node:path`、`node:http` 等其余内置模块。需要路径时直接把绝对路径传给 `node:fs`。
- `eval` 和 `new Function` 不可用。
- 一次调用的 JavaScript 堆上限是 256 MiB。比这更大的文件在读取前会失败。
- 一次工具或钩子调用的上限是 10 分钟。

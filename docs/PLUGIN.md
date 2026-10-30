# 插件

插件是一个 ES 模块，由 [moejs](https://github.com/MoeForge/moejs) 执行。在设置 → 插件填写来源即可安装。仓库里的 `plugins/web` 是随程序附带的联网插件，启动时如果清单里还没有同名插件，会自动安装。工具名仍然是 `web`。`plugins/chat-neko` 同样随程序附带，只在纯聊天里用 `systemPrompt` 追加猫娘人物设定。模块可以导出工具和对话钩子，也可以使用 moejs 的 [Web API](https://github.com/MoeForge/moejs/blob/main/docs/guide.zh_CN.md#web-api) 和 [Node.js 模块](https://github.com/MoeForge/moejs/blob/main/docs/guide.zh_CN.md#nodejs-%E6%A8%A1%E5%9D%97)。

安装后的文件在 `~/.loopra/plugins/packages/<id>`，清单是 `~/.loopra/plugins/installed.json`。设置了 `LOOPRA_JAVA_BACKEND_URL` 时，本进程不加载这些插件。

## 安装来源

来源可以是：

- `left-pad`、`left-pad@1.2.3`、`npm:@scope/pkg@1.2.3`
- `github:owner/repo`、`owner/repo#ref`、`https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/<ref>/<subdir>`
- 本地目录、`.tgz` / `.tar.gz`，或单个 `.js` / `.ts` 文件。可以写绝对路径、`./` 相对路径，或 `file:` 地址

不接受 `.jar`，以及不是 github.com 的 http(s) 地址。GitHub 没写分支时先试 `main`，再试 `master`。本地目录会原样复制后再安装其中的生产依赖。单个模块文件会放进一份临时的 `package.json`。

插件 id 会去掉开头的 `@`，把 `/` 换成 `__`，再把其余非字母数字字符收成 `_`。`demo-plugin` 的工具 `greet` 公开名称是 `demo_plugin__greet`。`@scope/pkg` 的 id 是 `scope_pkg`。

## 入口

按这个顺序找入口：

1. `package.json` 的 `loopra`：字符串，或 `{ "plugin": "./plugin.ts" }`、`{ "main": "./plugin.js" }`。对象里还可以写 `ui.settings`，见下面的设置页
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

`tools`、`call`、`meta`、`default`、`plugin`，以及下面的钩子名，不会注册成工具。只有钩子、没有工具的模块也可以加载。

函数可以是 `async`。宿主会等返回的 Promise 完成，再把结果交给对话。

## 钩子

钩子和工具可以写在同一个模块里，也可以写在 `export default` 上。多个插件按安装顺序串行，前一个的返回值交给下一个。某个插件抛错时跳过它，后面的继续。子代理用同一套钩子，并带上 `parentSessionId`。

每次调用都会带上当时能确定的 `invocationId`、`sessionId`、`app`、`agent`，以及这个插件自己的 `config`。`config` 就是设置页保存的对象，没有保存过时是 `{}`。

| 钩子 | 可以返回 | 作用 |
| --- | --- | --- |
| `turnBefore` | `{ message?, context?, cancel?, reason? }` | 改用户消息，或用 `cancel: true` 结束这一轮。默认说明是「这一轮已取消」 |
| `systemPrompt` | `{ text?, append? }` | `text` 替换已组装的系统提示词，`append` 接在后面 |
| `llmRequest` | `{ system?, messages?, temperature?, maxOutputTokens?, dropTools?, body? }` | 改这一次模型调用。`body` 替换即将 POST 的 JSON，HTTP 仍由宿主发送 |
| `llmResponse` | `{ text?, thought?, toolCalls? }` | 改模型最终回复。流式过程中的片段不会逐个改 |
| `toolBefore` | `{ decision?, args?, reason? }` | `allow` 可改参数，审批和路径检查仍然生效；`deny` 直接拒绝；`ask` 进入现有审批 |
| `toolAfter` | `{ result?, error? }` | 改工具结果，或把失败写成说明 |
| `compact` | `{ summary?, keep?, drop? }` | 改压缩摘要。`keep` 是字符串或字符串数组。`drop: true` 丢掉这次摘要 |
| `turnAfter` | 忽略 | 本轮结束时的清理。`status` 是 `completed`、`cancelled` 或 `error` |

`toolBefore` 在用户批准后会再进一次，这时 `approved` 为 `true`。`llmRequest.messages` 的每一项是 `{ role, text, parts }`，`parts` 里可以有 `text`、`thought`、`functionCall`、`functionResponse`。

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

`loopra` 写成对象时可以声明一个设置页。`plugins/chat-neko` 带了一份示例。

```json
{
  "loopra": {
    "plugin": "./plugin.js",
    "ui": { "settings": "./ui/index.html" }
  }
}
```

宿主在插件卡片上打开它，放进 iframe。`sandbox` 不带 `allow-same-origin`，页面读不到访问密钥和 `localStorage`。地址里也不放密钥。打开前宿主会给这个插件单独发一个 HttpOnly cookie，只在 `/api/plugins/<id>/ui` 下有效。

能取到的文件只限入口所在的目录，例如 `./ui/index.html` 只能再取 `ui/` 里面的文件。允许的类型是 HTML、CSS、JS、常见图片和字体。`..`、符号链接和其他类型都会拒绝。页面自己的 `fetch` 连不上 Loopra 接口。

样式和脚本要写在这个 HTML 里。页面在不透明源里，同目录下单独的样式表和脚本不会被浏览器应用。打开后宿主发：

```js
{ type: "loopra", op: "ready", plugin: { id, name }, theme }
```

`theme` 是一组不带 `--` 的颜色变量，例如 `surface`、`text`、`blue`。页面用同样的消息读写自己的配置。配置是一个 JSON 对象，最大 64 KiB，存在 `~/.loopra/plugins/ui-config/<id>.json`。重装插件不会清掉它，卸载会删掉。

```js
parent.postMessage({ type: "loopra", op: "config:get", id: "1" }, "*");
parent.postMessage({ type: "loopra", op: "config:set", id: "2", value: { nickname: "主人" } }, "*");
```

宿主只接受来自这个 iframe 的消息，并用 `{ type: "loopra", op: "config", id, value }` 或 `error` 回答。设置页不能调用插件工具。停用的插件仍然可以打开设置页。

## 边界

插件跑在 Loopra 进程里，文件和网络使用这个进程自己的操作系统权限。

这些限制还在：

- 插件自己的 `import` 不能越出插件目录，也不能导入 `http:` 地址。
- 没有安装 `node:path`、`node:http` 等其余内置模块。需要路径时直接把绝对路径传给 `node:fs`。
- `eval` 和 `new Function` 不可用。
- 一次调用的 JavaScript 堆上限是 256 MiB。比这更大的文件在读取前会失败。
- 一次工具或钩子调用的上限是 10 分钟。

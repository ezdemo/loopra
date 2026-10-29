# rg 搜索工具

原生 Agent 使用 `rg` 工具搜索项目，底层是官方 Rust ripgrep 15.2.0 的预编译可执行文件。它不是 Go 重写版，也不依赖系统安装的 `rg`。

旧的 `grep`、`glob`、`ls` 工具已从模型工具集移除。`rg` 不列目录项，但能列文件：枚举或统计文件用 `files` 模式，按内容筛选文件用 `files_with_matches`。只有查看目录结构时才使用当前系统 shell：PowerShell `Get-ChildItem`、CMD `dir`、macOS/Linux `ls` 或 `find`。

大型仓库中避免用 shell 做批量统计，例如 `Get-ChildItem -Recurse -Include *.java -File | Where-Object {...}` 后再逐文件 `Get-Content | Measure-Object -Line` 或 `Select-String`：`Where-Object` 在遍历之后才过滤，递归枚举加上逐文件读取常见耗时 20–40 秒；同样范围用 `rg` 通常不到 1 秒（实测 8557 个文件的项目：pwsh 7 递归枚举 22.5 秒，`rg --files -g '*.java' -g '*.kt'` 0.2 秒）。

## 三种模式

| `mode` | 原生行为 | `pattern` | 返回内容 |
| --- | --- | --- | --- |
| `content`（默认） | `rg -n -H` | 必填 | 文件名、从 1 开始的行号、匹配行原文 |
| `files` | `rg --files` | 不得提供 | 符合路径与 glob 规则的文件名，包括空文件和二进制文件 |
| `files_with_matches` | `rg -l` | 必填 | 内容匹配的文件名，每个文件只返回一次 |

`files` 查找文件路径，`files_with_matches` 根据内容筛选文件。两者不能混用。所有调用直接使用参数数组执行，不需要 shell 引号，也不会执行 pattern 中的 shell 表达式。

## 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `content` | 选择上述模式 |
| `pattern` | 无 | 内容正则或原样文本；仅 `files` 模式不接受 |
| `path` | 项目根目录 | 搜索的文件或目录，目录递归搜索 |
| `globs` | `[]` | rg 原生 `-g` 文件过滤数组 |
| `fixed_strings` | `false` | 原样文本匹配，对应 `-F` |
| `perl_regexp` | `false` | PCRE2 正则，对应 `-P`；不能与 `fixed_strings` 同用 |
| `ignore_case` | `false` | 忽略内容的大小写，对应 `-i` |
| `word_regexp` | `false` | 完整单词匹配，对应 `-w` |
| `context_lines` | `0` | 前后各显示的上下文行数，范围 0–20，仅用于 `content` |
| `hidden` | `false` | 包含隐藏文件和目录，不会自动禁用 ignore 规则 |
| `no_ignore` | `false` | 禁用 ignore 规则，不会自动包含隐藏项 |
| `max_depth` | `0` | 递归深度；0 不限，1 仅处理起始目录直接子项 |
| `max_results` | `200` | 最多输出行数，上限 1000；上下文和分隔符也占行数 |
| `timeout_ms` | `60000` | 搜索超时毫秒数，上限 120000 |

`path` 可使用项目内相对路径、当前项目内绝对路径，或者本轮已显式关联项目内的绝对路径。未授权的项目外路径和指向项目外的显式链接会被拒绝。递归时不跟随符号链接或 Windows junction；不读取设备、FIFO 等特殊文件。

## 正则与 glob

默认使用 Rust/Unicode 正则，区分大小写，不支持环视和反向引用。需要这些能力时指定 `perl_regexp=true`。搜索代码原样片段时优先使用 `fixed_strings=true`，避免把括号、点号等误当正则。

JSON 中反斜杠需要转义，例如正则 `func\s+New` 写成 `"func\\s+New"`。不要再套 shell 单引号或双引号。pattern 中不要写 HTML 实体（`&lt;`、`&gt;`、`&amp;`）：rg 会把它们当作字面文本，匹配 XML 标签应直接写 `<version>`。

`globs` 使用 `/` 分隔目录，支持 `*`、`**`、`?`、字符集合 `[...]` 和 `{go,ts}` 花括号展开。每个数组元素是一条 rg glob；普通逗号不会把一条模式拆成多个规则。

- `*.go`：匹配任意层级的 Go 文件。
- `**/*controller*.go`：按文件名筛选 controller。
- `!**/*_test.go`：排除测试文件。
- `!**/vendor/**`：排除 vendor 目录内容。
- `*.{go,ts}`：匹配 Go 或 TypeScript 文件。

规则保留输入顺序，最后一条匹配规则优先。显式正向 glob 可以覆盖 ignore 和隐藏规则；这沿用原生 rg 语义。

## 默认搜索范围

内容搜索默认跳过二进制文件和隐藏项，并使用 rg 的 `.gitignore`、`.ignore`、`.rgignore`、父目录和全局忽略规则。`.gitignore` 按原生 rg 的 Git 仓库检测生效，未初始化为 Git 仓库的目录与 Git 仓库可能有不同结果。

`hidden=true` 和 `no_ignore=true` 是独立开关。查找隐藏但未被忽略的配置时只开启 `hidden`；确实要搜索全部普通文件时同时开启两者，并用 `path`/`globs` 缩小范围。

工具固定使用 `--no-config`，并移除传给子进程的 `RIPGREP_CONFIG_PATH`，所以用户的 rg 配置文件不会改变参数或输出格式。

## 调用示例

搜索 Go 构造函数，并显示前后各两行：

```json
{"pattern":"func\\s+New","globs":["*.go"],"context_lines":2}
```

原样搜索含正则特殊字符的代码：

```json
{"pattern":"a.b(","fixed_strings":true,"path":"internal"}
```

按文件路径查找：

```json
{"mode":"files","globs":["**/*controller*.go","!**/*_test.go"]}
```

列出包含 TODO/FIXME 的文件：

```json
{"mode":"files_with_matches","pattern":"TODO|FIXME","globs":["!**/vendor/**"]}
```

使用 PCRE2 环视：

```json
{"pattern":"(?<=func )\\w+","perl_regexp":true,"globs":["*.go"]}
```

搜索被忽略的隐藏配置：

```json
{"pattern":"api_key","path":".config","hidden":true,"no_ignore":true,"max_results":50}
```

## 结果、限制和错误

返回对象包含：

| 字段 | 含义 |
| --- | --- |
| `result` | 原生 rg 文本输出；无结果时为 `(无匹配)` |
| `matched` | 是否找到匹配，或 `files` 模式是否找到文件 |
| `exit_code` | rg 的实际退出码 |
| `truncated` | 是否因为行数或字节限制主动截断 |
| `stderr` | 可选的执行诊断 |
| `stderr_truncated` | 可选的诊断截断标记 |

内容行形如 `path/to/file.go:12:original text`。上下文行使用 `-` 分隔字段，互不相邻的上下文段使用 `--` 分隔。不要只按冒号切割 Windows 路径，或把上下文行当作内容匹配。

正常退出码 0 表示有结果，1 表示无结果，2 表示搜索错误。无匹配是成功完成的查询；非法正则、不可读路径等执行错误会作为工具错误返回。

标准输出最多保留 64 KiB，诊断最多 8 KiB。超过 `max_results` 或字节限制时会取消当前搜索，终止进程树并返回已保留的结果及 `truncated=true`。这时实际退出码可能是信号终止产生的 `-1` 或平台终止码，不能据此认定搜索已完整完成。缩小范围后重试，或者用 `read` 读取目标文件。

超时和调用取消也会清理搜索进程树，并返回错误。

## 内嵌二进制和支持平台

预编译文件和校验清单位于 `internal/infrastructure/ripgrep/`。不同平台的 `//go:embed` 声明有独立构建约束，每个 Looprax 产物只嵌入自身平台的一份 gzip 压缩二进制。普通 `go build` 和运行时均不需要联网下载，也不会查找系统 PATH。

| GOOS | GOARCH | 上游预编译目标 |
| --- | --- | --- |
| windows | amd64 | x86_64-pc-windows-msvc |
| windows | arm64 | aarch64-pc-windows-msvc |
| windows | 386 | i686-pc-windows-msvc |
| darwin | amd64 | x86_64-apple-darwin |
| darwin | arm64 | aarch64-apple-darwin |
| linux | amd64 | x86_64-unknown-linux-musl |
| linux | arm64 | aarch64-unknown-linux-musl |
| linux | arm | armv7-unknown-linux-musleabihf；要求 `GOARM=7` |
| linux | s390x | s390x-unknown-linux-gnu；需要兼容的 glibc 环境 |

未列出的平台会返回明确的不支持错误，不会静默下载或改用另一套搜索实现。

首次使用时释放到：

```text
<os.UserCacheDir()>/looprax/rg/<version>/<GOOS>-<GOARCH>/<binary-hash>/rg[.exe]
```

缓存目录需要可写且允许执行。可以通过绝对目录环境变量 `LOOPRA_RG_CACHE` 改变缓存根路径，例如部署环境的可执行临时目录。应用会校验解压后的内嵌文件和已缓存文件的 SHA-256，发现缓存损坏时重新原子释放；并发调用共享缓存。上游许可证和第三方说明随程序嵌入，并写入二进制同目录。

旧 `grep` 的已保存工具配置会映射到 `rg`；已移除的 `ls` 不会映射为搜索工具。

## 更新内嵌版本

`manifest.json` 固定了版本、上游 Release asset ID、压缩包 SHA-256 和解压后可执行文件 SHA-256。更新时先核实官方 release 的目标文件及摘要，修改清单，再运行：

```text
python scripts/vendor-ripgrep.py
```

需要绕过本机代理时可以显式添加 `--no-proxy`。也可以通过 `--archive-dir <目录>` 提供已下载的上游 release 压缩包，文件名须与清单一致，脚本仍会验证固定的 SHA-256。已存在且校验通过的平台文件会直接复用。

脚本下载清单中固定的官方 GitHub asset，先校验压缩包，再读取需要的文件、生成确定性的 gzip 和平台 embed 源码，同时保留许可证。它不会把压缩包中的任意路径直接释放到磁盘。

把更新后的清单、所有平台压缩文件、生成的 Go 文件和许可证一起提交；发布构建不运行下载脚本。

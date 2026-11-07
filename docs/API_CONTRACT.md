# Loopra (agent4j) REST API 契约规格（Go 1:1 复刻目标）

> 来源：2026-10-27 从 `agent4j/loopra/src/main/java/site/sorghum/loopra/web/` 全部 22 个 controller 提取实证。
> 配套文档：[SSE 事件与持久化格式契约](SSE_AND_STORAGE_CONTRACT.md)。未指定端口时由系统分配空闲端口。
> 类型记法：`s`=string，`b`=boolean，`i`=int32，`l`=int64(epoch 毫秒)，`d`=double；`*`=必填。除特别注明外均为 JSON body（POST/PUT）或 query 参数（GET/DELETE）。

## 1. ApiResponse 包装结构

全部控制器返回值（SSE 与二进制端点除外）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `success` | b | 必有 |
| `error` | s? | 失败消息（中文） |
| `reason` | s? | 机器可读原因码（仅部分场景） |
| `data` | T? | 泛型业务数据 |

序列化（snack4 默认，null 字段整体省略）：
- 成功：`{"success":true,"data":...}`（`error/reason` 不出现；`ok(null)` → `{"success":true}`）
- 失败：`{"success":false,"error":"..."}`（`reason/data` 仅非 null 时出现）
- 无统一日期格式：DTO `date` 为 `"yyyy-MM-dd HH:mm:ss"`，`createdAt` 等为 epoch 毫秒。

## 2. 鉴权：WebAccessFilter

- 安装顺序：`CrossFilter(-100)` → `WebAccessFilter(-90)`；`GlobalExceptionFilter` 兜底。
- **Key 生成**：优先 env `LOOPRA_ACCESS_KEY`（匹配 `[A-Za-z0-9_-]{43,128}`），否则 SecureRandom 32 字节 → Base64url 无 padding（43 字符）。启动打印 `[Web Interface]: http://127.0.0.1:{port}/index.html?rk={key}`。
- **免鉴权路径**（仅 GET/HEAD）：`/`、`/config.json`、classpath `/static{path}` 存在的资源；前提：非 `/api`、`/api/`，且 path 不含 `..` 与 `\`。
- **校验**：header `X-Loopra-Key` 与 key 常量时间比较。
- **rk 参数**：仅 header 缺失、GET、且 path 匹配 `/api/pets/[^/]+/spritesheet` 时取 query `rk`。
- 每次响应：`Referrer-Policy: no-referrer`；非 bundled 路径加 `Cache-Control: no-store`。
- **401 响应体**：`{"success":false,"reason":"access_key_required","error":"访问密钥缺失或错误，请输入启动日志中的 rk 密钥"}`。
- **CORS**：allowedOrigins `*`、allowCredentials false、allowedHeaders `Content-Type,X-Loopra-Key,X-Request-ID,X-Timestamp,Authorization,Mcp-Session-Id,Mcp-Protocol-Version,Last-Event-ID`、exposedHeaders `Mcp-Session-Id`；GlobalExceptionFilter 对带 Origin 请求补回显头 + `Max-Age:3600`；OPTIONS 预检空串 200。
- **异常**：ServiceException → 对应 HTTP 状态（默认 400）+ `ApiResponse.fail(message, reason)`；其他异常 → 500 + `"服务暂时无法完成请求，请稍后重试"`。

## 3. 控制器契约清单

### 长期记忆（Go 原生运行时）

以下端点沿用普通 API 包装与公共鉴权；查询必须指定 `scope=global|project`。`project` 还要求已注册项目的 `workspaceHash`，不接受纯聊天或路径。全局请求不依赖当前项目。

项目记忆实际存放于注册项目根目录的 `.loopra/memory/memories.json`；API 和工具仍使用项目 hash，隔离工作树共享主项目记忆。旧版数据目录中的项目记忆仅在新位置文件缺失时校验并迁移，旧文件保留作备份。

| 方法与路径 | 请求 | data |
| --- | --- | --- |
| GET / HEAD `/api/memories` | `scope`、`workspaceHash?`、`query?`（标题与内容的空格分词匹配） | 记忆数组，按更新时间倒序；HEAD 无响应体 |
| POST `/api/memories` | JSON `{title,content,kind}` | 新记忆，`revision:1` |
| PUT `/api/memories/{id}` | JSON `{title,content,kind,revision}` | 更新后的记忆，revision 加一 |
| DELETE `/api/memories/{id}` | 查询 `revision` | `记忆已删除` |

条目为 `{id,title,content,kind,source,revision,createdAt,updatedAt}`，手工 API 写入的 `source` 固定为 `user`。参数无效返回 400 / `invalid_memory`，条目缺失返回 404 / `memory_not_found`，版本或同名标题冲突返回 409 / `memory_conflict`，存储失败返回 500 / `memory_storage_failed`。冲突后先重新读取，不得盲目覆盖。

只读 Agent 工具 `memory_search({action?,id?,query?,scope?,offset?,limit?})` 保留同一个入口，支持：

| action | 参数与行为 | 返回 |
| --- | --- | --- |
| `list`（默认） | 列全局及当前项目目录，可指定 scope；不接受 id 或非空 query | `{global?:{entries:[{id,title}],total,offset},project?:{entries:[{id,title}],total,offset}}`，不包含正文 |
| `read` | 必须明确提供 scope 与 id；仅读取该作用域，不接受 query 或分页参数 | `{scope,entry}`，entry 为完整记忆，包含最新 revision |
| `search` | 必须提供非空 query；按标题与正文匹配，可指定 scope | 分页结构同 list，但 entries 为匹配的完整记忆 |

list/search 默认每作用域 10 条、最多 20 条，offset 从零开始；省略 action 且传非空 query 时兼容旧的 search 调用。目录由现有记录生成，更新和删除后不维护另一份索引。HTTP GET `/api/memories` 仍返回完整条目供管理页使用。

`memory({action:"save"|"delete",scope,id?,revision?,title?,content?,kind?})` 写入时 `source` 固定为 `agent`；更新、删除必须提供 ID 与最新 revision。纯聊天不可使用项目作用域。以上三种只读操作及写入操作沿用禁用名单与现有审批策略。系统提示词引导新会话先查看目录，再由 Agent 根据对话按需读取正文；不自动加载目录或正文。环境信息使用前核实。

`→` 后为 `data` 字段结构。多数端点先检查 `agentService.isReady()`，未就绪 400 `"Agent 未初始化"`。

### 3.1 Chat（/api/chat）
| 方法+路径 | 参数 | data |
|---|---|---|
| POST `/stream` | body ChatRequest | SSE 流（见 SSE 契约文档；**唯一聊天入口**，无同步 POST、无 GET SSE） |
| POST `/abort` | body ChatRequest（只用 requestId/workspaceHash/sessionName；requestId/sessionName 至少一项） | `{status:"stopping"/"pending"/"not_running",matched:n}`；旧 requestId 对应会话已开始新一轮时返回 409、reason=`chat_run_changed`，不取消新一轮 |
| GET `/permissions` | q: workspaceHash*, sessionName* | `[{...pending 审批}]` |
| POST `/permission` | body `{workspaceHash*, sessionName*, permissionRequestId*, optionId*}` | s `"审批已提交"`；409 `"审批已结束或不属于当前会话"` |
| GET `/elicitations` | q: workspaceHash*, sessionName* | `[]` |
| POST `/elicitation` | body `{workspaceHash*, sessionName*, elicitationRequestId*, action, content:{}}` | s `"答案已提交"` |
| POST `/sub-hitl/{subId:i}` | body `{action:"approve"\|"deny"*}` | `{subId:i, action:s}` |

### 3.2 Agent（/api/agent）
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `/status` | — | `AgentStatusDTO{ready:b, model:s, workspace:s, cacheSize:i, historySize:i, hitlMode:s, sessionName:s, promptTokens:l, completionTokens:l}` |
| GET `/session-status` | q: workspaceHash*, sessionName* | `SessionStatusDTO{running:b, requestId:s?, title:s?}` |
| GET `/bash-sessions` | q: workspaceHash?, sessionName? | `[BashSessionDTO{sessionId:s, owner:s, workspaceHash:s, workspace:s, command:s, workdir:s, startedAt:l, status:s}]`（按项目与会话名共同隔离；省略 workspaceHash 时使用默认项目，省略 sessionName 时返回全局管理视图） |
| POST `/bash-sessions/terminate` | body `{workspaceHash?, sessionId?, sessionName?}` | s（跨项目或跨会话终止无效；省略 sessionId 时必须有 sessionName） |
| GET `/bash-sessions/log` | q: workspaceHash?, sessionId*, sessionName? | `BashSessionLogDTO{...,output:s}` |
| GET `/history` | q: workspaceHash*, sessionName* | `[]`（编译后历史视图） |
| GET `/history/events` | q: workspaceHash*, sessionName* | `[]`（ChatMessage 行，见 SSE 契约 §3） |
| GET `/commands` | — | `[{cmd:s, desc:s, args:s}]` |
| GET `/acp-state` | q: workspaceHash*, sessionName* | `{plan:[{content,status,priority}], commands:[{name,description,inputHint}]}` |
| GET `/prompt` | q: workspaceHash?, sessionName? | `{content:s, length:i}` |
| GET `/project-capabilities` | q: workspaceHash* | `{workspacePath, mcpConfigPath, mcpConfigExists:b, projectSkillsPath, projectSkillsDirectoryExists:b, skills:[{name,description,scope,mountAlias,path}], mcpServers:[{name,type,enabled:b,loaded:b,toolCount:i,toolNames:[],error}]}` |
| POST `/project-capabilities/refresh` | q: workspaceHash* | 同上 |
| GET `/skills` | — | `[{name, description, scope:s(""), runAs:s(id), directoryName:s}]`。已启用插件的技能 scope 为 `@plugin-skills/<插件 id>` |

### 3.3 AgentEngines（/api/agent-engines）
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `` | — | `[Engine{id:s, name:s, available:b, detail:s}]`（首项 native） |
| GET `/mcp` | q: agentId*, workspaceHash* | `[{name, type, source:s("project"/"global"), configuredEnabled:b, enabled:b}]` |
| PUT `/mcp` | body `{agentId, workspaceHash, name*, enabled:b*}` | 同 GET /mcp（404→400 `"MCP 配置不存在，请刷新后重试"`） |
| GET `/preferences` | — | `{selectedAgent:s?, agents:{}: {agentId: {configId: s\|b}}}` |
| PUT `/preferences` | body `{selectedAgent*}` | 同上 |
| GET `/session` | q: workspaceHash*, sessionName* | `{agentId:s, hasMessages:b}` |
| GET `/config` | q: workspaceHash*, sessionName* | `{configOptions:[...]}` |
| POST `/prepare` | body `{workspaceHash*, sessionName?, agentId?}` | `{sessionName:s, agentId:s, configOptions:[...]}`（空 sessionName 新建 `loopra-<uuid>`） |
| PUT `/config` | body `{workspaceHash, sessionName*, configId*, value*}` | `{configOptions:[...]}` |

### 3.4 Config（/api）
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `/config` | — | ConfigDTO（apiKey 脱敏 `前4+****+后4`，短 key→`"****"`；字段全集见契约代理原始输出） |
| GET `/ui-preferences` | — | `{theme:light\|dark\|system, language:zh\|en, fontScale:80\|90\|100\|110\|120, notifications:b, sound:b, openWith:s, autoContext:b, animations:b, petEnabled:b?, lastWorkspace:s?, profile:{nickname,avatar,color}?, persisted:b}`。文件不存在时 `persisted:false` 且不创建文件。个人资料、宠物开关、lastWorkspace 没保存过时省略。旧文件里的 `hiddenSessions` 在下次保存时丢弃 |
| PUT `/ui-preferences` | body 同上，缺省字段保留已保存值；theme 也接受 `浅色`/`深色`/`跟随系统`，language 也接受 `简体中文`/`English`。lastWorkspace 只接受项目 hash（12 位十六进制或 __loopra_chat__），显式传空表示忘掉记录 | 同 GET，`persisted:true`。非法外观、语言、缩放、打开应用、个人资料或项目记录 → 400 |
| PUT `/config` | body `{}` 任意键值合并 | s：渠道类→`"模型渠道已更新，Agent 已重新初始化"`，否则 `"配置已更新"`；广播 config.changed 键：model/reasoningEffort/hitl/fastMode/disabledTools |
| GET `/models` | — | `{current, currentChannelId, models:[{name,active,channelId,channelName,displayName}]}` |
| GET `/remote-models` | q: channelId? | `[s]`（GET `{baseUrl}/models` 取 `$.data[].id`） |
| POST `/remote-models` | body `{channelId?, baseUrl?, apiKey?, apiProtocol?, specialCompatibility?}` | `[s]` |
| GET `/usage` | q: workspaceHash*, sessionName? | `UsageDTO{promptTokens,completionTokens,cacheHit,cacheMiss,lastPromptTokens,maxContextTokens,totalTokens,model,hasPrice,inputCost,cacheCost,outputCost,totalCost,currency,contextEstimate:{...},contextSource,contextEstimateScope}` |
| GET `/workspace` | — | s |
| POST `/workspace` | body `{path*}` | `{message, workspace, currentSession:null}`（400 `"无效的工作目录路径: ..."`） |
| GET `/workspaces` | — | `[{hash,name,path,createdAt,lastAccessedAt,sessionCount,displayName?,linkedProjectHashes?,linkedProjectPaths?}]` |
| PUT `/workspaces/{hash}/name` | body `{displayName}` | ProjectInfoDTO |
| PUT `/workspaces/{hash}/links` | body `{linkedProjectHashes?:[hash...],linkedProjectPaths?:[绝对路径...]}`，至少提供一个列表；省略的列表保留，空数组清空对应列表 | 更新后的 ProjectInfoDTO；已有项目与独立目录按实际目录去重、合计最多 8 个；独立目录无需登记项目，也不出现在项目列表；无效项目、不可用目录、自身目录或纯聊天返回 400 |
| DELETE `/workspaces/{hash}` | — | s `"项目已删除"`；删除前先把其他项目对该标识的长期关联改写为目录关联，改写失败则不删除 |
| PUT `/workspaces/order` | body `[hash...]` | s `"排序已保存"` |
| GET `/workspaces/order` | — | `[s]` |

项目长期关联保存在主项目元数据中，旧记录缺省为空。`linkedProjectPaths` 是关联的规范形式，保存独立目录的绝对路径（解析符号链接和 Windows 目录联接），不创建项目记录，也不切换当前工作区；工作台里「选择已有项目」「选择文件夹」和输入路径都只写入该列表。`linkedProjectHashes` 保留为旧客户端与既有数据的兼容入口，解析时仍按目录生效；删除某个项目时，服务端先把其它项目对它的标识关联改写为目录关联（按目录去重并保留未知字段），因此项目列表删除不会使关联失效。省略列表时保留其原值，兼容只提交项目标识的旧客户端。原生 Agent 的系统提示词列出主项目、副项目及绝对路径；不拼接到用户消息。每轮执行合并两类长期关联与 `ChatRequest.linkedProjectHashes` 临时关联，按目录去重后最多 8 个，且不递归继承副项目的关联。不可用的长期关联不授予权限（目录关联的元数据保留供用户解除）；显式临时关联无效时返回错误。修改从下一轮生效，已开始的轮次沿用其目录快照。外部 ACP 引擎（包括 Codex）通过 `additionalDirectories` 接收相同的目录列表；会话预热、读取或修改配置与发送均解析默认关联项目和隔离分支目录，避免首次发送无故重建连接。临时关联仍在发送时合并，列表变化后重新建立或恢复会话。

开启 `toolsRestrictWorkspace` 时，`write` / `edit` 接受主项目内相对路径，以及主项目或有效副项目内的绝对路径，仍检查符号链接越界。审批策略将这些目录视为工作区，`blockedPaths` 在各工作区继续生效。只读工具和 shell `cwd` 保持原有范围；关联不额外授予副项目的记忆、技能或插件配置。
| GET `/loopra-md` | — | s |
| PUT `/loopra-md` | body 裸字符串 | s `"loopra.md 已保存，Agent 已重新初始化，新会话将使用更新后的提示词"` |
| GET `/usage/dashboard` | q: days?(7) | `{totalPromptTokens,...,dailyStats:[...],modelStats:[...],modelPrices:{}}` |

### 3.5 Tools（/api/tools）
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `` | — | `[{name, description, readOnly, readOnlyOverride?, stormExempt, enabled, autoApproved, chat, async, params}]`；`params` 来自工具 schema，异步工具包含通用 `yield_after_ms` |
| POST `/{name}/toggle` | — | s `"已禁用/启用工具: x"`（400 `"工具不存在: x"`） |
| POST `/{name}/auto-toggle` | — | s `"已添加/移除自动放行: x"` |
| POST `/{name}/read-only` | body `{readOnly:b?}`（null=默认） | s `"已将工具分类设置为只读/写入/默认: x"` |
| GET `/{name}` | — | ToolInfoDTO |

### 3.6 Mcp（/api/mcp）
`McpServerDTO={name(s,匹配^[a-zA-Z0-9_-]+$), type("stdio"/"sse"/"streamable"), enabled(b,默认true), command?, args?:[s], env?:{}, url?, headers?:{}, timeout?:s("30s"/"500ms"/"2m")}`；stdio 需 command，sse/streamable 需 http(s) url。
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `/servers` | — | `[McpServerDTO]` |
| POST `/servers/add` \| `/update`（`{originalName?, server*}`）\| `/remove`（`{name*}`）\| `/toggle`（`{name*, enabled}`） | body | DTO / s `"服务器已删除"` |
| POST `/servers/check` | body McpServerDTO | s `"连接成功"` / fail `"连接失败，请检查服务器配置"`（15s 超时） |
| GET `/servers/tools` | q: name* | `{connected:b, tools:[{name,description}], disallowedTools:[s]}` |
| POST `/servers/tools/save` | body `{serverName*, disallowedTools:[s]}` | s `"工具权限已保存"` |
| GET `/export` | — | `{enabled, name, version, channel, endpoint, allowedTools?, tools:[{name,description,readOnly,enabled,exposed}], endpointUrl}` |
| PUT `/export` | body McpExportConfig（默认 enabled=false,name=loopra,version=1.0.0,channel=streamable,endpoint=/mcp,allowedTools=null=全量） | 同上 |
| POST `/export/refresh` | — | 同上 |
| GET `/tunnel` \| PUT `/tunnel/config` \| POST `/tunnel/start` \| POST `/tunnel/stop` | —/`{executablePath}`/`{executablePath?}`/— | `{state,running,installed,quickTunnel,mcpReady,platform,configuredExecutablePath,executablePath,localUrl,publicUrl,mcpEndpoint,error,pid:l}` |

### 3.7 Sessions（/api/sessions）
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `` | q: workspaceHash? | `[{name,title,messageCount:l,current:b,mtime:l,worktreeMode:b,agentId:s(默认"native")}]`（仅含写入过消息的会话：`.jsonl` 或审计 `.events` 有内容） |
| PUT `/order` | q: workspaceHash*; body `[sessionName...]` | s `"排序已保存"` |
| GET `/current` | q: workspaceHash? | `{workspaceHash, sessionName}` |
| POST `/new` | q: workspaceHash*, sessionName?, worktreeMode?:b | `{message:"已创建新会话", workspaceHash, sessionName}`（惰性：不创建会话日志，首条消息写入时才落盘） |
| GET/PUT `/{name}/settings` | q: workspaceHash*; body `{model?, modelChannelId?, reasoningEffort?}` | 同 body |
| GET/PUT `/{name}/worktree` | body `{worktreeMode?:b, mergeMode?:s("manual"/"ai-auto"/"ai-auto-approve")}` | `{workspaceHash, sessionName, worktreeMode, mergeMode}` |
| PUT `/{name}/title` | body `{title*}` | s |
| POST `/{name}` | q: workspaceHash* | `{workspaceHash, sessionName, switched:b}`（惰性切换，允许尚未落盘的会话名） |
| DELETE `` \| `/cleanup`(before:l*) \| `/{name}` | — | `{message, workspaceHash, sessionName}` |
| POST `/evict-all` | — | s `"已清除所有 Agent 缓存"` |
| POST `/{name}/branch` | q: messageCount:i*(>0，**按 `/api/agent/history` 返回的可见行计数**，即前端 `historyCount`；一个 ADK 事件可能占多行，切点取整事件) | `{message:"已分支到新会话",...}` |
| POST `/{name}/fork` | — | `{message:"已创建会话分叉",...}` |
| GET `/stats` | — | `{cacheSize:i, maxCacheSize:i=50}` |
| GET `/{name}/checklist` \| `/{name}/goal` | q: workspaceHash* | null 或清单/目标结构（见契约代理原始输出） |
| POST `/file-changes/revert` | body `{workspaceHash*, changes:[{path,additions,deletions,created,diff}]}` | `{message:"已撤销本次 AI 的文件修改", revertedFiles:i}` |

### 3.8 Plugins（/api/plugins）
GET `` 与 GET `/external` → `[{id,displayName,description,remark,version,source,sourceUrl,enabled,state,error,tools:[s],hooks:[s],entry,settings?:b,builtin?:b,requests?:b,icon?:{name?:s,key?:s,dataUrl?:s,hidden?:b},sidebar?:{title,icon?},panel?:{title,icon?},menu?:{title,category?:s,icon?,page?:b,children?:[{id,title,icon?}]}}]`。`hooks` 是已加载的钩子名：`turnBefore`、`systemPrompt`、`llmRequest`、`llmRequestSent`、`llmResponse`、`toolBefore`、`toolAfter`、`compact`、`turnAfter`。`settings` 为真表示声明了设置页，`requests` 为真表示已加载页面后端 `onRequest`。`builtin` 为真表示 `plugins/` 目录里的内置插件，可以停用，不能卸载或单独更新。`sidebar` 出现时表示侧栏有入口，`panel` 表示右侧面板有页签。`menu` 出现时表示设置导航有插件菜单。`icon.hidden:true` 表示插件显式隐藏图标；`icon.name` 是 Lucide 图标名，`icon.key` 要用访问密钥取 `GET /{id}/icons/{key}`。
POST `/install` 与 POST `/external/install`，body `{source*}`。`source` 是 npm 包名（可带版本或 dist-tag）、`npm:@scope/pkg`、`github:owner/repo`、`owner/repo#ref`、`https://github.com/owner/repo`，或本地路径（目录、`.tgz` / `.tar.gz`、`.js` / `.ts`，以及 `file:` 地址）。`.jar` 以及不是 github.com 的 http(s) 地址返回 400。

POST `/{id}/update` 与 `/external/{id}/update`，无需请求体 → 更新后的同一插件项。npm 重新解析 `latest`（即使原安装来源指定了版本），GitHub 保留原 ref 和子目录，本地来源重新读取原路径。保留配置、持久数据、安装顺序和启停状态；下载、编译、包名校验或清单保存失败返回 400，并保留旧包和运行时。内置插件返回 400「内置插件随应用更新」。相同版本也会重新获取，不做版本大小比较。版本展示以已安装项为准，详见[更新与版本](PLUGIN.md#更新与版本)。

GET `/sources` → `[s]`；POST `/sources`，body `{source*}` → 去重后的源列表；POST `/sources/remove`，body `{source*}` → 剩余源列表，已安装插件不受影响。GET `/catalog?source=<编码后的仓库地址>` → `[{id,name,description?,version?,source,icon?}]`，读取源中的包清单，未安装插件也可提供图标；安装时传该项的 `source`。默认源为 `https://github.com/ezdemo/loopra-plugins`，源列表持久化到 `~/.loopra/plugins/sources.json`。

POST `/{id}/toggle` 与 `/external/{id}/toggle`，body `{enabled:b}` → 同一插件项。POST `/{id}/remove|uninstall` 与 `/external/{id}/remove` → `插件已卸载: <id>`。`builtin:true` 时返回 400，正文是「内置插件不能卸载」。
POST `/{id}/ui/open` 为这个插件的设置页签发 HttpOnly cookie `loopra_plugin_ui`（Path `/api/plugins/{id}/ui`，SameSite=Lax，一小时），响应 `{ok:true, page:"/plugins/{id}/ui/t/{ticket}/"}`。`page` 里的票据不是访问密钥，只够读取这个插件的页面文件。GET `/{id}/ui` 与 `/{id}/ui/*` 返回入口目录里的静态文件，接受该 cookie 或 `X-Loopra-Key`，不接受 `?rk=`。GET `/{id}/ui/t/{ticket}` 与其下的文件接受路径里的票据，不必带 cookie；`_loopra/bridge.js` 是宿主桥。页面的内容安全策略允许该目录下的脚本、样式、图片和字体，也允许内联脚本和样式，`connect-src 'none'`。POST `/{id}/sidebar/open` 与 GET `/{id}/sidebar`、`/{id}/sidebar/*`、`/{id}/sidebar/t/{ticket}/*` 同样处理侧栏页面，cookie Path 是 `/api/plugins/{id}/sidebar`。POST `/{id}/menu/open` 与 GET `/{id}/menu`、`/{id}/menu/{child}`、`/{id}/menu/{child}/*`、`/{id}/menu/t/{ticket}/{child}/*` 同样处理设置菜单，cookie Path 是 `/api/plugins/{id}/menu`。GET `/{id}/icons/{key}` 返回声明的图标，只接受访问密钥。GET `/{id}/config` 与 POST `/{id}/config` 读写插件自己的 JSON 对象（最大 64 KiB），只接受访问密钥。GET `/schedules` 返回已启用插件声明的定时任务，带 `plugin:true`。POST `/schedules/{id}/run` 立刻在纯聊天里执行一次。
工具公开名称是 `<插件 id>__<导出名>`。只读工具自动放行，写入工具走审批。安装文件在 `~/.loopra/plugins/packages/<id>`，清单是 `~/.loopra/plugins/installed.json`。

POST `/{id}/panel/open` 与 GET `/{id}/panel`、`/{id}/panel/*`、`/{id}/panel/t/{ticket}/*` 提供右侧面板页面，cookie Path 为 `/api/plugins/{id}/panel`，沙箱和资源范围沿用设置页规则。纯聊天也可使用插件面板。

POST `/{id}/request`，body `{action*, value:{}, context?:{workspaceHash?,workspaceDir?,sessionId?,filePath?}}` → 插件 `onRequest({action,value,config,context})` 返回的 JSON 值。任意已启用、成功加载且声明 `onRequest` 的插件均可用，不限于 OpenAPI；操作由插件显式分发，不自动调用工具。请求体最多 64 KiB，`action` 不超过 128 字节，处理最多 30 秒。请求仍需要访问密钥，iframe 使用 `service:request` / `service:result` 消息，由工作台固定插件身份并代发当前上下文，不向 iframe 传密钥。后端可声明 `openapi`、`sessions` 宿主服务，见[页面后端](PLUGIN.md#页面后端)和[声明宿主服务](PLUGIN.md#声明宿主服务)。

### 3.9 Extpacks（/api/extpacks）
GET `` → `[]`。POST `/install` 及其他写操作返回 400，提示改到插件页用 npm 包或 GitHub 地址安装。

### 3.10 Git（/api/git）
`GitStatusDTO={gitAvailable,initialized,branch,workspacePath,changed:[GitFileChange],untracked:[GitFileChange],model,modelChannelId,ahead:i,behind:i,upstream?}`；`GitFileChange={path,index,workTree,status}`（未跟踪项为 `index:"?"`, `workTree:"?"`, `status:"U"`）。
主要端点：GET `/branch|diff|status|diff-content|file-content|working-file-content|log(limit 50)|config`、POST `/init|commit|toggle|config|generate-commit-message|generate-environment-commit-message`、GET `/environment(+/status|/log)`、POST `/environment/commit|push|toggle`、GET `/environment/diff-content|working-file-content`、POST `/worktree/create`（`{workspaceHash*, sessionName*, discardChanges?}`，幂等）。workspaceHash 大多可选（空=当前项目）。

### 3.11 Snapshots（/api/snapshots）
POST `/checkpoint`（q: msgId*）→ `{msgId,commitHash,treeHash,createdAt:l}`；POST `/rollback`（JSON 或 query：msgId? / rollbackTimestamp? / rollbackCode:b=true；纯聊天忽略 rollbackCode，只撤回消息）→ `{msgId,commitHash,treeHash,success,message,rollbackUserText?}`；GET ``；GET `/status`；DELETE `/{msgId}`。

### 3.12 Requirements（/api/requirements）
实体：`{id,title,description,priority(high/medium/low),projectHash,projectName,status(todo/doing/done/failed),scheduleMode(immediate/scheduled),model,modelChannelId,reasoningEffort,hitl,approvalPending:b,scheduledAt:l,summary,sessionName:"req_<id>",createdAt,updatedAt}`。
GET ``；POST ``（title*、projectHash*）；PUT `/{id}`（仅 description/priority）；DELETE `/{id}`；POST `/{id}/comments`（`{text*}`）；GET `/{id}/messages`；POST `/{id}/run`（并发上限 2）；POST `/{id}/approval`（approve/deny）；POST `/{id}/abort`。

### 3.13 Schedules（/api/schedules）
`ScheduledTask={id,name,sessionName,sessionMode("independent"/"existing"/null),cronExpr?,intervalSec:l?,message*,enabled,lastRunAt,nextRunAt,runCount,lastResult,lastError,runs:[...],createdAt,updatedAt}`；q 均 workspaceHash*。GET ``、`/{id}`；POST ``；PUT `/{id}`；POST `/{id}/toggle|run`；DELETE `/{id}`。校验：message 必填；非 independent 需 sessionName；cron 与 interval 至少一项。

### 3.14 SkillMarket（/api/skill-market）
GET `/markets`（默认 skillhub/clawhub）；GET `/proxy`（action=trending|search）；GET `/detail`（slug*）；POST `/install`（slug*，装到 ~/.loopra/skills）；POST `/uninstall`（slug*, scope?）。

### 3.15 SubAgents（/api/sub-agents、/api/sub-sessions）
GET `/api/sub-agents` → `[{id,name,description,readOnly,systemPrompt,tools:[s],allowedTools?,enable?,builtin,plugin?,modelChannel?,model?}]`；PUT 全量保存（`{profiles:[{id*,name,description,instructions,enable?,readOnly?,allowedTools?,modelChannel?,model?}]}`）。`plugin:true` 的角色由已启用插件提供，保存时会被忽略。GET `/denied-tools`。
GET `/api/sub-sessions`（q: workspaceHash*, sessionName*）→ `[{subSessionId,task,name,title,profile,status,startedAt,endedAt,eventCount,mtime}]`；GET `/{subSessionId}/events`；DELETE `/{subSessionId}`（运行中 400）；POST `/{subSessionId}/chat`（body `{"message"}`）→ SSE（sub_* 事件）。

### 3.16 OpenApi（/api/openapi）
GET `/sources`；GET `/search`（keyword* 空格 AND）；POST `/sources`（`{docUrl*, headers?, authType?(none/bearer/apikey/basic), authConfig?}`）；DELETE `/sources`（body `{docUrl*}`）；PUT `/sources/refresh`。

### 3.17 其它
- POST `/api/model-meta/refresh` → s。
- GET `/api/version/` → `{version,buildTime,name}`；GET `/version/check`；POST `/version/update`（+GET、/stop）。开发桌面构建的版本检查直接返回当前版本和 `hasNewVersion:false`，不请求发布服务。
- GET `/api/desktop-update/state` → `{supported,development?,unsupportedReason?,currentVersion,latestVersion,status,revision,source,changingSource,percent,transferred,total,bytesPerSecond,error,checkedAt,packageType?}`。桌面正式打包产物需具备三段正式版本号和 RFC3339 构建时间；缺失时返回 `development:true,supported:false,status:"unsupported"`，保留当前版本并提供原因。
- POST `/api/desktop-update/check`、`/download`、`/source`（`{source}`）、`/install`；GET `/api/desktop-update/notes`。开发构建的检查、下载返回原状态，更新源和安装请求返回 400，不触发发布检查或安装；手动读取日志仍可请求正式发布历史，忽略本地开发版本号的大小，且不会启动更新任务或写入下载文件。普通 Web 服务未创建桌面更新器时，这组接口返回 404。
- POST `/api/system/open-workspace`（`{workspaceHash?, application?}`）；GET `/open-applications`；POST `/pick-directory`；GET `/health`（`{status:"ok",version,buildTime}`）；GET `/system/version`。
- Pets：GET `/api/pets`、`/{name}`、`/{name}/spritesheet`（webp，支持 ?rk=）、`/active`（active 时含 position、scale?、desktop?；desktop 为原生窗口右下角的屏幕坐标）、`/desktop`（`{native, dismissed}`；native 为真时本进程用 mygo 画宠物，页面不再叠在输入框上）；PUT `/active`（`{name*}`）、`/position`（x、y、sizeIndex、scale、desktopX、desktopY；任一桌面坐标为 null 时清除 desktop）、`/desktop`（`{shown, name, label, activity, reply, replyId, replyActivity, latest, scale, seen, reset?}`；seen 小于 dismissed 时忽略显示）；DELETE `/{name}`。
- Files：GET `/api/files/image|tree|search`、DELETE `/delete`（禁删项目根）、POST `/paste`（`{content*}` → `.loopra/paste`）。
  - `/api/files/image`：`path` 必填，`workspaceHash` 与可选 `sessionName` 确定文件所属环境。相对路径基于会话实际工作目录（含隔离工作树），缺失工作树不回退主项目；省略会话时保持项目根目录行为。绝对路径沿用只读图片访问语义，可读取临时目录图片。只接受普通文件、最多 5 MiB，以及 PNG/JPEG/GIF/WebP/BMP/AVIF 内容类型；拒绝 SVG。响应为图片二进制，保留鉴权、GET/HEAD、`nosniff` 与 `no-store`。
- PromptPresets：GET/PUT `/api/prompt-presets`（`[{id,label≤24,text≤500}]`，id 空自动 UUID）。

### 3.18 Bot（/api/bots）

全局资源，沿用访问密钥鉴权与响应包装，不受当前工作区选择影响：

| 方法与路径 | 请求 / 响应 |
| --- | --- |
| GET / HEAD `/bots` | `[{id,name,platform:"feishu",appId,ownerId,workspaceHash,enabled,allowedUserIds:[],allowedChatIds:[],chats:[],state,error?,createdAt}]`，不返回 App Secret |
| PUT `/bots/{id}` | 全量可编辑配置 `{name,enabled,allowedUserIds:[],allowedChatIds:[]}`，返回更新后的 Bot |
| DELETE `/bots/{id}` | 停止连接、取消所属执行与未完成授权，保留项目和历史 |
| POST `/bots/registrations` | `{name?,botId?}`；`botId` 表示重新授权已有应用，省略时创建；返回授权状态 |
| GET / HEAD `/bots/registrations/{id}` | `{id,name,state,url?,qrCode?,expiresAt?,botId?,error?}`；二维码为本地生成的 PNG data URL，响应 `Cache-Control:no-store` |
| DELETE `/bots/registrations/{id}` | 取消授权轮询，不创建 Bot |

授权状态为 `starting / waiting / completed / failed / cancelled`；连接状态为 `connecting / connected / reconnecting / offline / error / disabled`。二维码过期、拒绝或网络错误可以重新获取；重新授权须返回同一 App ID，保留项目及聊天绑定。新授权成功后才创建默认项目，不切换当前项目。

资源不存在返回 404 / `bot_not_found`，服务关闭返回 503 / `bot_unavailable`，配置保存失败返回 500 / `bot_storage_failed`；保存失败保留旧配置和连接。

`chats` 项为 `{chatId,sessionName,chatType,updatedAt}`。Bot 只有一个默认项目，多代码库访问复用该项目的 `linkedProjectHashes / linkedProjectPaths`，不按飞书聊天切换项目。单聊、群聊分别映射会话，工作台与飞书共用历史、执行互斥、取消及工具审批。首版使用 Native，回复通过 `post` 富文本的 `md` 节点由飞书原生渲染 Markdown，长回复分段时保留代码围栏及语言标记；附件不会交给模型假定已读取。默认仅 owner 可用，其他用户需授权；群聊还须允许该群并明确 @Bot，忽略 @all。

消息先持久化绑定及最近 512 条消息 ID，再异步执行，避免模型耗时阻塞事件确认。同一聊天执行中不接受第二轮，返回忙碌提示；保存失败不执行，重启后保留去重信息。已接收的失败任务不会因同一消息重复投递自动重跑，需用户再次发送。单轮最长 30 分钟，工作台审批计入该时长。

## 4. 静态资源与 /config.json

- 前端产物在 classpath `/static/`（GET/HEAD 免鉴权由 §2 规则判定）。
- `GET /config.json`（免鉴权、无 ApiResponse 包装）输出：`{\n  "apiBase": "/"\n}`。
- 未匹配路由 404（非 ApiResponse 体）。

## 5. Go 实现要点

1. `ApiResponse` 省略 null 字段（非 null 才输出）。
2. 401 固定四段体（含 `reason:"access_key_required"`）；常量时间比较 key。
3. SSE 帧严格遵守 `event:` + `data:` + 双 `\n`；文本事件（content/reasoning）的 data 是**裸 JSON 字符串**，需自实现转义（`"`、`\`、`\n`、`\r`、`\t`、<0x20 → `\u00XX`）。
4. SSE 中途错误一律 HTTP 200 + `error` 事件 + 紧跟 `done`；仅建流前校验错误用 HTTP 状态码。
5. 建流后发生的 409/503（requestId 重复、队列满、会话运行中）通过 SSE `error` 事件报告。

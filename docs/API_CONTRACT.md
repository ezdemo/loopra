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

`→` 后为 `data` 字段结构。多数端点先检查 `agentService.isReady()`，未就绪 400 `"Agent 未初始化"`。

### 3.1 Chat（/api/chat）
| 方法+路径 | 参数 | data |
|---|---|---|
| POST `/stream` | body ChatRequest | SSE 流（见 SSE 契约文档；**唯一聊天入口**，无同步 POST、无 GET SSE） |
| POST `/abort` | body ChatRequest（只用 requestId/workspaceHash/sessionName） | s `"已发送中断请求"` |
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
| GET `/bash-sessions` | q: workspaceHash? | `[BashSessionDTO{sessionId:s, workspace:s, command:s, workdir:s, startedAt:l, status:s}]` |
| POST `/bash-sessions/terminate` | body `{sessionId*, workspaceHash?}` | s |
| GET `/bash-sessions/log` | q: sessionId*, workspaceHash? | `BashSessionLogDTO{...,output:s}` |
| GET `/history` | q: workspaceHash*, sessionName* | `[]`（编译后历史视图） |
| GET `/history/events` | q: workspaceHash*, sessionName* | `[]`（ChatMessage 行，见 SSE 契约 §3） |
| GET `/mode` | q: workspaceHash*, sessionName* | `{}` 计划模式状态 |
| POST `/mode` | body `{workspaceHash, sessionName*, enabled:b}` | `{}` |
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
| GET `/ui-preferences` | — | `{theme:light\|dark\|system, language:zh\|en, fontScale:80\|90\|100\|110\|120, notifications:b, sound:b, openWith:s, autoContext:b, animations:b, petEnabled:b?, profile:{nickname,avatar,color}?, persisted:b}`。文件不存在时 `persisted:false` 且不创建文件。个人资料、宠物开关没保存过时省略。旧文件里的 `hiddenSessions` 在下次保存时丢弃 |
| PUT `/ui-preferences` | body 同上，缺省字段保留已保存值；theme 也接受 `浅色`/`深色`/`跟随系统`，language 也接受 `简体中文`/`English` | 同 GET，`persisted:true`。非法外观、语言、缩放、打开应用或个人资料 → 400 |
| PUT `/config` | body `{}` 任意键值合并 | s：渠道类→`"模型渠道已更新，Agent 已重新初始化"`，否则 `"配置已更新"`；广播 config.changed 键：model/reasoningEffort/hitl/fastMode/disabledTools |
| GET `/models` | — | `{current, currentChannelId, models:[{name,active,channelId,channelName,displayName}]}` |
| GET `/remote-models` | q: channelId? | `[s]`（GET `{baseUrl}/models` 取 `$.data[].id`） |
| POST `/remote-models` | body `{channelId?, baseUrl?, apiKey?, apiProtocol?, specialCompatibility?}` | `[s]` |
| GET `/usage` | q: workspaceHash*, sessionName? | `UsageDTO{promptTokens,completionTokens,cacheHit,cacheMiss,lastPromptTokens,maxContextTokens,totalTokens,model,hasPrice,inputCost,cacheCost,outputCost,totalCost,currency,contextEstimate:{...},contextSource,contextEstimateScope}` |
| GET `/workspace` | — | s |
| POST `/workspace` | body `{path*}` | `{message, workspace, currentSession:null}`（400 `"无效的工作目录路径: ..."`） |
| GET `/workspaces` | — | `[{hash,name,path,createdAt,lastAccessedAt,sessionCount,displayName?}]` |
| PUT `/workspaces/{hash}/name` | body `{displayName}` | ProjectInfoDTO |
| DELETE `/workspaces/{hash}` | — | s `"项目已删除"` |
| PUT `/workspaces/order` | body `[hash...]` | s `"排序已保存"` |
| GET `/workspaces/order` | — | `[s]` |
| GET `/loopra-md` | — | s |
| PUT `/loopra-md` | body 裸字符串 | s `"loopra.md 已保存，Agent 已重新初始化，新会话将使用更新后的提示词"` |
| GET `/usage/dashboard` | q: days?(7) | `{totalPromptTokens,...,dailyStats:[...],modelStats:[...],modelPrices:{}}` |

### 3.5 Tools（/api/tools）
| 方法+路径 | 参数 | data |
|---|---|---|
| GET `` | — | `[{name, description, readOnly, readOnlyOverride?, stormExempt, enabled, autoApproved, params:[](恒空)}]` |
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
| GET `` | q: workspaceHash? | `[{name,title,messageCount:l,current:b,mtime:l,worktreeMode:b,agentId:s(默认"native")}]`（仅含写入过消息的会话：`.jsonl` 或审计 `.events` 有内容；只有 `.meta` 的计划模式会话例外） |
| PUT `/order` | q: workspaceHash*; body `[sessionName...]` | s `"排序已保存"` |
| GET `/current` | q: workspaceHash? | `{workspaceHash, sessionName}` |
| POST `/new` | q: workspaceHash*, sessionName?, worktreeMode?:b | `{message:"已创建新会话", workspaceHash, sessionName}`（惰性：不创建会话日志，首条消息写入时才落盘） |
| GET/PUT `/{name}/settings` | q: workspaceHash*; body `{model?, modelChannelId?, reasoningEffort?}` | 同 body |
| GET/PUT `/{name}/worktree` | body `{worktreeMode?:b, mergeMode?:s("manual"/"ai-auto"/"ai-auto-approve")}` | `{workspaceHash, sessionName, worktreeMode, mergeMode}` |
| PUT `/{name}/title` | body `{title*}` | s |
| POST `/{name}` | q: workspaceHash* | `{workspaceHash, sessionName, switched:b}`（惰性切换，允许尚未落盘的会话名） |
| DELETE `` \| `/cleanup`(before:l*) \| `/{name}` | — | `{message, workspaceHash, sessionName}` |
| POST `/evict-all` | — | s `"已清除所有 Agent 缓存"` |
| POST `/{name}/branch` | q: messageCount:i*(>0) | `{message:"已分支到新会话",...}` |
| POST `/{name}/fork` | — | `{message:"已创建会话分叉",...}` |
| GET `/stats` | — | `{cacheSize:i, maxCacheSize:i=50}` |
| GET `/{name}/checklist` \| `/{name}/goal` | q: workspaceHash* | null 或清单/目标结构（见契约代理原始输出） |
| POST `/file-changes/revert` | body `{workspaceHash*, changes:[{path,additions,deletions,created,diff}]}` | `{message:"已撤销本次 AI 的文件修改", revertedFiles:i}` |

### 3.8 Plugins（/api/plugins）
GET `` 与 GET `/external` → `[{id,displayName,description,remark,version,source,sourceUrl,enabled,state,error,tools:[s],hooks:[s],entry,settings?:b,builtin?:b,icon?:{name?:s,key?:s},sidebar?:{title,icon?},menu?:{title,icon?,page?:b,children?:[{id,title,icon?}]}}]`。`hooks` 是已加载的钩子名：`turnBefore`、`systemPrompt`、`llmRequest`、`llmResponse`、`toolBefore`、`toolAfter`、`compact`、`turnAfter`。`settings` 为真表示声明了设置页。`builtin` 为真表示 `plugins/` 目录里的内置插件，可以停用，不能卸载。`sidebar` 出现时表示侧栏有入口。`menu` 出现时表示设置导航有插件菜单。`icon.name` 是 Lucide 图标名，`icon.key` 要用访问密钥取 `GET /{id}/icons/{key}`。
POST `/install` 与 POST `/external/install`，body `{source*}`。`source` 是 npm 包名（可带版本或 dist-tag）、`npm:@scope/pkg`、`github:owner/repo`、`owner/repo#ref`、`https://github.com/owner/repo`，或本地路径（目录、`.tgz` / `.tar.gz`、`.js` / `.ts`，以及 `file:` 地址）。`.jar` 以及不是 github.com 的 http(s) 地址返回 400。
POST `/{id}/toggle` 与 `/external/{id}/toggle`，body `{enabled:b}` → 同一插件项。POST `/{id}/remove|uninstall` 与 `/external/{id}/remove` → `插件已卸载: <id>`。`builtin:true` 时返回 400，正文是「内置插件不能卸载」。
POST `/{id}/ui/open` 为这个插件的设置页签发 HttpOnly cookie `loopra_plugin_ui`（Path `/api/plugins/{id}/ui`，SameSite=Lax，一小时），响应 `{ok:true}`，正文不包含票据。GET `/{id}/ui` 与 `/{id}/ui/*` 返回入口目录里的静态文件，接受该 cookie 或 `X-Loopra-Key`，不接受 `?rk=`。POST `/{id}/sidebar/open` 与 GET `/{id}/sidebar`、`/{id}/sidebar/*` 同样处理侧栏页面，cookie Path 是 `/api/plugins/{id}/sidebar`。POST `/{id}/menu/open` 与 GET `/{id}/menu`、`/{id}/menu/{child}`、`/{id}/menu/{child}/*` 同样处理设置菜单，cookie Path 是 `/api/plugins/{id}/menu`。GET `/{id}/icons/{key}` 返回声明的图标，只接受访问密钥。GET `/{id}/config` 与 POST `/{id}/config` 读写插件自己的 JSON 对象（最大 64 KiB），只接受访问密钥。GET `/schedules` 返回已启用插件声明的定时任务，带 `plugin:true`。POST `/schedules/{id}/run` 立刻在纯聊天里执行一次。
工具公开名称是 `<插件 id>__<导出名>`。只读工具自动放行，写入工具走审批。安装文件在 `~/.loopra/plugins/packages/<id>`，清单是 `~/.loopra/plugins/installed.json`。

### 3.9 Extpacks（/api/extpacks）
GET `` → `[]`。POST `/install` 及其他写操作返回 400，提示改到插件页用 npm 包或 GitHub 地址安装。

### 3.10 Git（/api/git）
`GitStatusDTO={gitAvailable,initialized,branch,workspacePath,changed:[GitFileChange],untracked:[GitFileChange],model,modelChannelId,ahead:i,behind:i,upstream?}`；`GitFileChange={path,index,workTree,status}`（未跟踪项为 `index:"?"`, `workTree:"?"`, `status:"U"`）。
主要端点：GET `/branch|diff|status|diff-content|file-content|working-file-content|log(limit 50)|config`、POST `/init|commit|toggle|config|generate-commit-message|generate-environment-commit-message`、GET `/environment(+/status|/log)`、POST `/environment/commit|push|toggle`、GET `/environment/diff-content|working-file-content`、POST `/worktree/create`（`{workspaceHash*, sessionName*, discardChanges?}`，幂等）。workspaceHash 大多可选（空=当前项目）。

### 3.11 Snapshots（/api/snapshots）
POST `/checkpoint`（q: msgId*）→ `{msgId,commitHash,treeHash,createdAt:l}`；POST `/rollback`（msgId? / rollbackTimestamp? / rollbackCode:b=true）→ `{msgId,commitHash,treeHash,success,message,rollbackUserText?}`；GET ``；GET `/status`；DELETE `/{msgId}`。

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
- GET `/api/version/` → `{version,buildTime:"",name}`；GET `/version/check`；POST `/version/update`（+GET、/stop）。
- POST `/api/system/open-workspace`（`{workspaceHash?, application?}`）；GET `/open-applications`；POST `/pick-directory`；GET `/health`（`{status:"ok",version,buildTime}`）；GET `/system/version`。
- Pets：GET `/api/pets`、`/{name}`、`/{name}/spritesheet`（webp，支持 ?rk=）、`/active`（active 时含 position、scale?、desktop?；desktop 为原生窗口右下角的屏幕坐标）、`/desktop`（`{native, dismissed}`；native 为真时本进程用 mygo 画宠物，页面不再叠在输入框上）；PUT `/active`（`{name*}`）、`/position`（x、y、sizeIndex、scale、desktopX、desktopY；任一桌面坐标为 null 时清除 desktop）、`/desktop`（`{shown, name, label, activity, reply, replyId, replyActivity, latest, scale, seen, reset?}`；seen 小于 dismissed 时忽略显示）；DELETE `/{name}`。
- Files：GET `/api/files/image|tree|search`、DELETE `/delete`（禁删项目根）、POST `/paste`（`{content*}` → `.loopra/paste`）。
- PromptPresets：GET/PUT `/api/prompt-presets`（`[{id,label≤24,text≤500}]`，id 空自动 UUID）。

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

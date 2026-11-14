# Loopra SSE 事件协议 + 持久化文件格式契约（Go 1:1 复刻目标）

> 来源：2026-10-27 从 `agent4j/loopra`（bin/session、bin/agent/output、web/service）与 `loopra-front/web/src` 前端消费侧双端提取实证。
> 配套文档：[REST API 契约](API_CONTRACT.md)。

## 0. 传输与链路

- Loopra Mobile 通过加密 HTTP 隧道原样消费现有 SSE，不转换事件或业务字段。手机断线不取消后台 Agent，明确停止仍走原生 abort API；会话、元数据与追加审计保持原格式。中继配置继续使用 `alma-relay.json`。详见 [MOBILE.md](MOBILE.md)。

- AI 回复图片使用普通 Markdown `![说明](<图片路径>)`，随现有正文事件与 JSONL 文本保存，不新增图片事件或附件字段。本地路径通过 `/api/files/image` 按消息所属工作区和会话读取；HTTP/HTTPS 图片由浏览器直接加载。主会话、历史恢复和子代理回放共用图片加载与放大预览。历史引用原文件当前内容，不保存图片快照，原文件删除后显示不可读取。原生、纯聊天及子代理提示词共用展示约定；外部 ACP 通过独立的 prompt 文本块接收该约定，该块不改写 Loopra 保存的用户转录。
- Windows 图片路径兼容反斜杠分隔符，包括 `C:\Users\name\.loopra\image.png`；渲染时保留标点目录前的分隔符，避免被 Markdown 转义吞掉。普通图片与引用式图片共用该行为，代码块和行内代码保持原文。
- 文档附件随用户 `message` 文本持久化：末尾独立的 `loopra-attachments` 代码围栏包含单行 JSON 数组 `[{name,text,size?}]`，`text` 为提取后的全文，`size` 为原始字节数。围栏长度大于内容中的连续反引号长度；图片仍使用 `images` / `contentParts`。实时气泡与历史恢复均从同一文本解析附件，以图标和文件名标签显示，点击在模态浮层预览全文，正文不重复展示附件全文。格式无效时保留原文；旧消息保持可读，不推断普通文字中的附件边界。
- SSE 端点：`POST /api/chat/stream`，请求体 `ChatRequest`：`{message, requestId(UUID), workspaceHash(12位md5), sessionName(默认"default"), agentId?, customAgentId?, model?, modelChannelId?, reasoningEffort?, fastMode?, stream?(遗留不消费), images?:string[](dataURL), linkedProjectHashes?:string[]}`。非空 `action` 返回 400；原生计划执行入口已移除。`customAgentId` 把会话绑定到某个自定义智能体角色（仅项目工作区 + `agentId:"native"`；语义见 API 契约「自定义智能体」一节）。
- SSE 帧：`event: <type>\n` + `data: <json>\n\n`，UTF-8；响应头 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
- 前端解析：按 `\n` 切行去 `\r`；`event:` 行设 type；`data:` 行累积 join `\n`；空行=帧结束。data 先 JSON.parse：对象→`{...obj,type}`，字符串→`{type,content}`；`[DONE]`→`{type:'done'}`；无 `event:` 名默认 `'content'`。**没有名为 `message` 的 SSE 事件**。
- 写失败：emitter 断开后置 completed 静默丢弃后续事件，**Agent 照常执行到自然结束**。
- 建流前校验失败（body null/message 空→400 `"message 不能为空"`；action 非法→400；mergeMode 非法→400；Agent 未就绪→503 `"Agent 未初始化"`）走 HTTP；建流后错误走 SSE `error`+`done`。
- 并发准入：16 线程池 + 64 队列；重复 requestId→409 `"requestId 已有正在处理的聊天任务"`；队列满→503 `"聊天任务已满，请稍后重试"`；同 (workspace,session) 运行中→409（以上建流后经 SSE error 报告）。abort：POST /api/chat/abort 携 requestId。
- 取消：任务先登记再刷新 SSE 响应头；提前到达的 requestId 取消记录保留 2 分钟，最多 4096 条，登记时消费。取消会立即唤醒命令等待并终止所属会话的后台 shell 进程树，清理完成前不释放该会话准入；旧 requestId 不得取消替代轮次。原生执行中取消以 `complete{stopReason:"cancelled",status:"cancelled"}`、`done` 结束，尚未开始执行的轮次直接 `done`。

## 1. SSE 事件协议全表

### 1.1 基础/终止
| type | data JSON | 触发 |
|---|---|---|
| `snapshot` | `{msgId: string(8位hex), hasCodeSnapshot: boolean}` | 每条用户消息回合开始 |
| `content` | **裸 JSON 字符串**（`"token"`） | 正文增量 |
| `reasoning` | **裸 JSON 字符串** | 思考增量（非流式完整思考也走此事件） |
| `reasoning_started` | `{}` | 思考开始但无可见 token |
| `complete` | Native：`{content: string}`（最终完整回复）；外部 ACP：`{stopReason: "cancelled"\|"max_tokens"\|"max_turn_requests"\|"refusal"}` | 回合结束 |
| `error` | `{error: string, reason?: string}` | 任何异常；**发送后立即自动 complete()** |
| `done` | `{}` | 终止事件、关流；仅非 error 正常收尾发送 |
| `log` | `{level: string(DEBUG/INFO/WARN/ERROR), message: string}` | 调试日志 |
| `stream_reset` | `{}` | 模型流重试/压缩后作废重发；前端回退末尾 content/reasoning 块 |

### 1.2 工具
| type | data JSON |
|---|---|
| `tool_call` | `{toolCallId: string, name: string, args: string(JSON 对象序列化，null→"{}")}`（旧版无 id 形态：`{name, args: object}`） |
| `tool_update` | `{toolCallId, name?, args?}` 或增量输出 `{toolCallId, result: string}` |
| `tool_result` | `{toolCallId, name, result: string(null→""), status: "completed"\|"failed"}`（旧版 `{name, result}`；`duration`(number ms) 可选）。并行调用时每个工具**一完成就发送**对应结果，不等整批结束；同一 `toolCallId` 只发送一次 |
| `file_changes` | `{changes: [{path, additions:int, deletions:int, created:boolean, diff:string}]}`（编辑工具后或回合结束汇总） |

半异步工具沿用上述事件：`running` 回执不发终态 `tool_result`，真实完成时按原调用 ID 上报一次；`complete` / `done` 等待待处理结果送回 Loop。JSONL 为回执增加 `tool_status:"running"`，晚到结果追加 `async_tool_result:true` 的 tool 行与真实 ADK 通知事件，前端更新原条目而不新增用户气泡。查询、取消和恢复细节见[半异步工具契约](ASYNC_TOOLS.md)。

### 1.3 用量与速率

| type | data JSON |
|---|---|
| `usage`(Native) | `{promptTokens:int, completionTokens:int, totalTokens:int, cacheHit:int, cacheMiss:int, lastPromptTokens:int}`（每次模型调用后累计值） |
| `usage`(外部 ACP) | `{used: long, size: long, cost?: double, currency?: string, model?: string}` |
| `token_speed` | `{completionTokens: long, tokensPerSecond: double, avgTokensPerSecond: double, done: boolean}` |

### 1.4 HITL / 交互
- `choice`（ask_choice/计划确认）：`{title?, description?, options: [{title, value}]}`。
- `choice`（审批，requestPermission）：`{permissionRequestId: string(UUID), title(默认"工具调用需要审批"), description: string(rawInput JSON), options: [{title, value: optionId, kind: "allow_once"/"reject_once" 等小写}]}`。
- `sub_choice`：同上 + `subId`。
- `permission_resolved`：`{permissionRequestId, optionId}`（取消时 `"cancelled"`）。
- `elicitation`：`{elicitationRequestId: UUID, sessionId, message, schema: object(JSON Schema)}`；`elicitation_resolved`：`{elicitationRequestId, action: "cancel"/"accept"}`。
- 应答接口：POST `/api/chat/permission`、`/api/chat/elicitation`、`/api/chat/sub-hitl/{subId}`。
- 会话切换：历史刷新保留该会话内尚未回答的普通 `choice`；审批和表单待处理请求由运行中的 `/chat/permissions`、`/chat/elicitations` 恢复。弹框未提交的答案、补充输入与当前题目按服务、会话和请求隔离，保存在当前工作台内存中，切换后恢复；成功提交后清除，不写入会话日志或浏览器持久存储，刷新页面后草稿不保留。

### 1.5 模式/计划/配置
| type | data |
|---|---|
| `mode_changed` | `{"mode": string}`（外部 ACP Agent 的模式 ID） |
| `config_options` | `{configOptions: [AcpConfigOption{id,name,description,category,type:"select",currentValue,options:[{id,name,description}]}]}` |
| `acp_plan` | `{entries: [{content, status:"pending"/"in_progress"/"completed", priority:"high"/"medium"/"low"(默认medium)}]}` |
| `acp_commands` | `{commands: [{name, description, inputHint: string\|null}]}` |

### 1.6 子代理事件（payload 含 `subId`；Native 为进程内自增 int 字符串化，ACP 路由时为父 toolCallId；另含 `subSessionId`：匹配 `[A-Za-z0-9_-]{1,64}` 原样，否则 SHA-256 hex = 磁盘 `.sub/{subSessionId}.jsonl` 文件名）
`sub_start{subId,subSessionId?,task,name?,title?,parentSubId?,startedAt:l}`、`sub_content{subId,token}`、`sub_reasoning{subId,token}`、`sub_reasoning_started{subId}`、`sub_tool_call{subId,toolCallId?,name,args:string}`、`sub_tool_update`、`sub_tool_result{subId,toolCallId?,name,result,status}`（并行调用时每个工具一完成就发送，同一 `toolCallId` 仅一次；`.sub` 审计日志仍按合并事件记录一次）、`sub_file_changes{subId,subSessionId,changes:[...]}`（与 `file_changes` 使用同一变更格式，持久化到子会话日志并保留父会话的变更记录）、`sub_usage{subId,model?,promptTokens,completionTokens,totalTokens,cacheHit,cacheMiss}`、`sub_error{subId,error}`、`sub_log`、`sub_plan{subId,entries:[...]}`、`sub_complete{subId}`、`sub_end{subId,status:"completed"/"aborted"/"error",error?(仅error),endedAt:l}`。
顺序约定：首 `sub_start`，末 `sub_end`（幂等；取消补发 aborted）。

## 2. 前端消息模型（loopra-front 拼装规则，Go 端只需按上表发事件）

```
Message={id, role:'user'|'assistant', text, blocks?:ChatBlock[], time?, startedAt?, finishedAt?,
         historyCount?, rollbackId?, snapshotId?, rollbackTimestamp?, images?:string[]}
ToolStatus='成功'|'执行中'|'失败'
ChatBlock= content|reasoning|reasoning_started{content} | tool_call{toolCallId?,name,status,args?,result?,duration?}
         | file_changes{changes:[{path,additions,deletions,created?,diff?}]}
         | checklist{title,steps:[{description,status:'done'|'active'|'pending',result?}]}
         | sub_agent{name,status,blocks:ChatBlock[]} | choice{question,description?,subId?,permissionRequestId?,options:[{title,value?,description?}],selected?}
```
- content/reasoning 追加末尾同类型块；tool_call 按 toolCallId 建块（args JSON.parse）；tool_result 回填（status failed 或 result 前缀 `/^(错误|Error|Exception|\[failed\])/i` 判失败）。
- sub_* 剥前缀后**递归**归约进 sub_agent 块。
- `finish`、`ask_choice` 视为最终答复边界。
- 流式缓冲：纯文本事件 40ms 合帧，非文本事件与首个非空文本立即 flush（32KB/128 条上限）。

## 3. JSONL 会话行格式

- 位置：`~/.loopra/workspace/{hash}/sessions/{sanitize(name)}.jsonl`；无项目 `~/.loopra/sessions/`。sanitize：`[^\p{L}\p{N}_\-\[\]]`→`_`；默认会话名 `loopra-yyyyMMddHHmm`。
- 每行一个 JSON（UTF-8，`\n` 结尾），**全部 snake_case**：
  - `role`（user/assistant/tool/system，必有）、`content`（string 或多模态数组 `[{type:"text",text},{type:"image_url",image_url:{url,detail?}}]`）、`reasoning_content`、`response_reasoning`（原始思考 JSON）、`acp_message_id`
  - `file_changes`: `[{path,additions,deletions,created,diff}]`、`snapshot_id`（仅在创建了 Git 代码快照时写入）、`rollback_id`（8 位 msgId，用来定位要撤回的消息）、`web_hidden`(true 才写)、`timestamp`(ms)
  - 回合计时：`turn_started_at`/`turn_finished_at`/`elapsed_ms`；工具计时：`tool_started_at`/`tool_finished_at`/`tool_duration_ms`
  - `tool_call_id`（tool 行关联）、`tool_image_url`/`tool_image_detail`、`tool_calls`（assistant 行：`[{id(缺失→"unknown"),type:"function",function:{name,arguments:string(JSON 字符串)}}]`）、`thinking_blocks`
- 追加：逐条同步写+立即 flush；rewrite 走 `.tmp` + `Files.move(REPLACE_EXISTING)` 原子替换；**`.events` 从不重写**。
- load 跳过空行、`//` 注释行与内部通知行。

## 4. 伴生文件与目录

`hash` = 项目绝对路径 UTF-8 MD5 前 6 字节 hex（12 位）。会话簇（`{name}` 为 sanitize 基名）：
- `{name}.jsonl`：主日志（见 §3）。**延迟创建**：新建会话只切换当前会话并写 `.meta` 设置快照，首条消息写入时才创建 `.jsonl`/`.events`；会话列表只包含已写入过消息的会话（`.jsonl` 或从不重写的 `.events` 有内容；回滚截断为空也仍算）。只有 `.meta` 或旧版本遗留的“只有 0 字节 `.jsonl`、无 `.events`”空白会话不进入列表。
- `{name}.events`：**append-only 审计镜像**（append 时与 .jsonl 同步双写，rewrite 不触碰）。
- `{name}.meta`：JSON 读-改-写 + temp 原子替换，**必须保留未知键**。键：`title`、`worktreeMode:b`、`mergeMode`(默认"manual")、`model`、`modelChannelId`、`reasoningEffort`、`agentId`(默认"native")、`acpSessionId`、`acpCwd`、`acpUsage:{used,size,cost?,currency?,model?}`、`acpPlan:[...]`、`acpCommands:[...]`、`agentConfig:{}`。旧 `planMode`、`pendingPlan` 字段保留但不再参与原生工具过滤、提示词或会话列表。`agentConfig` 记录用户在会话里选定的 Agent 配置（模型、权限模式、思考强度等），外部 ACP Agent 的计划配置继续透传。恢复 ACP 会话时先读这份快照、把与 Agent 默认值不同的项重新下发，再回写；Agent 拒绝或未列出的键一律保留，不能因一次恢复失败丢失用户的选择。
- Codex 空白线程在首条消息前可能没有 rollout。恢复该线程明确返回 `no rollout found for thread id <当前 acpSessionId>` 时，只有 `.jsonl` 和 `.events` 均不存在或为 0 字节才允许重建远端线程，并恢复保存的 `agentConfig`；重建成功后更新绑定。已有审计记录（即使可见历史被回滚清空）、损坏但非空的日志、历史检查失败、取消及其他远端错误都不触发重建，失败保留旧绑定及原文件。
- `{name}.usage`：`{prompt,completion,cacheHit,cacheMiss,lastPromptTokens}`（long；全 0 删除）。
- `{name}.model_usage`：`{"<model>": [prompt,completion,cacheHit,cacheMiss]}`（空删除）。
- `{name}.sub/{subSessionId}.jsonl`：子代理会话（每行 `{type:"sub_*",...payload}`；subSessionId 白名单校验防穿越；缺 `sub_end` 视为运行中）。
- 项目级：`workspace/{hash}/workspace.json`（`{path,displayName:null,createdAt,lastAccessedAt,linkedProjectHashes?:string[],linkedProjectPaths?:string[]}`）、`workspace/{hash}/goals/`、`workspace/{hash}/schedules/schedules.json`。两类关联缺省为空：`linkedProjectPaths` 保存目录的规范绝对路径（解析符号链接及 Windows 目录联接），是关联的规范形式；`linkedProjectHashes` 仅为旧客户端和既有数据保留，解析时同样按目录生效。删除项目时先把其它项目对它的标识关联改写为目录关联（按目录去重、保留未知字段），因此项目列表删除不会让关联失效；目录关联不创建项目记录或会话目录。按实际目录去重后合计最多 8 个；保存使用项目元数据锁及原子替换，并保留其他字段；只更新其中一类时保留另一类。关联仅展开一层，每轮与临时关联合并用于系统提示词、write/edit 写入边界和审批策略；不可用的长期目录不授予权限，元数据仍保留；修改从下一轮生效。
- Bot：`bots.json` 为 `{bots:[{id,name,platform,appId,appSecret,ownerId,tenantBrand,workspaceHash,enabled,allowedUserIds,allowedChatIds,chats,seenMessages,createdAt,updatedAt}]}`。缺失文件视为空列表，损坏配置报错且不覆盖；根对象和 Bot 对象的未知字段保留。凭证只存本地，使用同一互斥边界读改写、临时文件及原子替换，先保存再发布连接变更。授权中的二维码只存在内存，关闭或取消后停止轮询；重启不恢复未完成授权。默认工作目录为 `bot-projects/{botId}`，项目和 JSONL 使用既有存储格式；删除 Bot 不删除这些文件。`chats` 保存飞书聊天到会话的稳定绑定，`seenMessages` 保存最近 512 条已接收消息 ID。Bot 轮次按所属项目解析长期关联，并传入与工作台相同的目录快照和会话工具所有者上下文。
- 64 路分片锁：按文件绝对路径 hashCode 取模互斥（Go 建议 per-abs-path mutex 分片）。
- 全局：`~/.loopra/usage_daily.jsonl` 每行 `{ts(ms),model,prompt,completion,cacheHit,cacheMiss}`（全 0 不写）。

## 5. config.json 及其它配置

### 5.1 `~/.loopra/config.json`（键/类型/默认值）
`baseUrl("https://api.deepseek.com/v1")`、`apiKey`、`proxy`(旧名 proxyAddress 兼容)、`model("deepseek-v4-flash")`、`modelChannelId("default")`、`apiProtocol`(旧全局，建议渠道级)、`validationModel(+"ChannelId")`、`imageUnderstandingModel(+"ChannelId")`、`toolModel(+"ChannelId")`、`modelChannels[]`、`editMode("auto"|"yolo")`、`reasoningEffort(low/medium/high/max,默认high)`、`lang("ZH"|"EN")`、`hitl("free"|"approval"|"auto"; 旧 boolean 兼容)`、`autoWhitelist[]`(默认 32 项含 read/glob/write/ls/grep/edit/sub_agent/goal_*)、`maxContextChars(200000)`、`keepTailChars(80000)`、`contextCompaction{thresholdRatio:0.8,retainRatio:0.16,compactionRetries:1,toolResultPrune{thresholdChars:8192,headChars:4096,tailChars:1024}}`、`toolTimeoutSec(360)`、`subAgentTimeoutSec(3600)`、`maxSelfCorrectionAttempts(5)`、`maxStreamErrorRetries(10)`、`flushIntervalSec(30)`、`foldHeadCharsLimit(60000)`、`stormWindowSize(6)`、`stormThreshold(3)`、`toolResultTruncateChars(16000)`、`toolResultKeepChars(12000)`、`price{model:{input,cache,output}(每百万 RMB)}`、`disabledTools[]`、`disabledPlugins[]`、`toolReadOnlyOverrides{tool:bool}`、`toolsRestrictWorkspace(false，开启后 write/edit 只能使用项目内及本轮关联项目内的路径；read/rg/read_image 与命令工具不受影响)`、`blockedPaths[]`、`fastMode(false)`、`availableModels[]`、`workspaceDir`、`worktreeBaseDir(~/.loopra/worktree)`、`activePet`。
- `modelChannels[]`：`{id(缺省"channel-N"),name,baseUrl,apiKey,apiProtocol,specialCompatibility(""|deepseek|mimo|opencode),models[]}`；models 条目 `{name,displayName?,contextTokens(-1=未知),maxTokens(-1→默认),imageInput,price?{input,cache,output}}`，兼容纯字符串。
- 加载：不存在写默认；递归合并缺省；迁移工具名 task→sub_agent、goal_mark_step→goal_update_step；未配置 workspaceDir 初始化 `~/.loopra/defaultWorkSpace`。
- 原生 Agent 的 `contextCompaction.enabled` 缺省为开启，`retainEvents` 缺省为 12；`retainRatio`、`compactionRetries`、`keepTailChars` 为兼容保留字段。循环内压缩、原始工具结果投影和诊断见[上下文管理](CONTEXT_COMPACTION.md)。

### 5.2 其它
- 长期记忆：全局 `~/.loopra/memories.json`（`LOOPRA_HOME` 可替换数据根目录），项目 `<项目根目录>/.loopra/memory/memories.json`。项目根目录从 `workspace/{hash}/workspace.json` 的注册路径解析，隔离工作树沿用主项目目录。若新文件缺失而旧位置 `~/.loopra/workspace/{hash}/memories.json` 存在，首次读取时先校验，再原子写入新位置并保留旧文件作备份；新位置已有文件（包括空列表）时不再读取旧位置，损坏的新文件也不回退到旧数据。格式为 `{version:1, entries:[{id,title,content,kind,source,revision,createdAt,updatedAt}]}`。`kind` 为 `fact|preference|environment`，`source` 为最后写入方 `user|agent`，时间为 UTC RFC3339 纳秒格式。缺失文件按空列表读取，损坏或不支持的版本返回错误，禁止自动清空；顶层未知字段保留。应用共享仓库串行化读改写，写入使用临时文件加原子替换。更新、删除要求匹配 `revision`，避免手工编辑与 Agent 并发覆盖。纯聊天只加载全局记忆。每作用域最多 500 条，标题 1–120 字、内容 1–4000 字，文件不超过 8 MiB。
- 记忆读取：系统提示词引导新会话先用 `memory_search(action="list")` 查看全局和当前项目的目录（仅 ID 与标题），再按需用 `action="read"`、scope、id 读取正文；也支持 `action="search"`、query 搜索与目录分页。目录从记录生成，不存在独立索引文件。后台不自动读取记忆或附加正文；AI 主动调用工具后的结果作为普通工具事件进入对话，沿用现有持久化和上下文管理。未读取的记忆文件损坏不阻止普通对话，实际检索或保存失败时返回错误。记忆存储不改写 `loopra.md`、`AGENTS.md` 或会话 JSONL。入口与正文分离的思路参考 [Claude Code 的记忆设计](https://code.claude.com/docs/en/memory#how-it-works)，Loopra 沿用 JSON 记录与现有管理页。
- `~/.loopra/agent-preferences.json`：`{selectedAgent:null, agents:{agentId:{optionId: string|boolean}}}`（排除 plan 选项）。
- `~/.loopra/ui-preferences.json`：尚未单独成接口的工作台设置 `{theme:light|dark|system, language:zh|en, fontScale, notifications, sound, openWith, autoContext, animations, petEnabled, lastWorkspace(上次打开的项目 hash), profile:{nickname,avatar,color}}`。不存在时 GET 不创建。若已有 `desktop.json`，保存时同步其 `theme` 字段。服务地址仍只存在客户端。lastWorkspace 让换浏览器或换设备后仍回到上次的项目（浏览器 `loopra:last-workspace` 仅作为服务端记录到达前的缓存）。旧的 `hiddenSessions` 不再读取，下次保存时从文件中去掉。
- `~/.loopra/agent-mcp.json`：`{agents:{agentId:{serverName: boolean}}}`。
- `mcp-servers.json`（用户级 ~/.loopra/ 与项目级 .loopra/）：Loopra 格式 `{"servers":[McpServerDTO]}` 或标准 `{"mcpServers":{name:{...}}}`（也接受裸映射；mcpServers 优先）。McpServerDTO：`{name, type:"stdio"|"sse"|"streamable"("http"/"streamable-http"→streamable; 空→有 url 无 command 即 streamable), enabled:true, command?, args?, env?, url?, headers?, timeout?("30s"/"500ms"/"2m")}`。
- `~/.loopra/mcp-server.json`：`{enabled:false, name:"loopra", version:"1.0.0", channel:"streamable"|"streamable_stateless"|"sse", endpoint:"/mcp", allowedTools:null|[string]}`（null=全部已启用，[]=不发布）。

## 6. ~/.loopra 目录清单

config.json、agent-preferences.json、ui-preferences.json、agent-mcp.json、mcp-servers.json、mcp-server.json、model_meta.json、prompt-presets.json、loopra.md、memories.json（全局记忆）、usage_daily.jsonl、sessions/（无项目会话）、workspace/{hash}/（workspace.json、sessions/、goals/、schedules/、可能保留旧版 memories.json 备份）、requirements/requirements.json、skills/、plugins/（installed.json、packages/&lt;id&gt;/）、worktree/、chat-workspace/（纯聊天，hash=`__loopra_chat__`）、defaultWorkSpace/、pet/、logs/http/。
项目内 `.loopra/`：mcp-servers.json、skills/、memory/memories.json（项目记忆）、read_img/、paste/、workspace/workspace.json（共享上下文）、checklists/{sessionId}.json。旧文档曾列出的 `loopra-memory.md` 没有对应的当前读写实现，结构化项目记忆使用 `memory/memories.json`。

## 7. 复刻要点

1. `content`/`reasoning` 的 data 是**裸 JSON 字符串**；其余事件 data 均为 JSON 对象。
2. `error` 后必须跟 `done`；`done` 是唯一关流信号。
3. 双 usage 形态共用 `usage` 事件名，按字段存在性判别。
4. `.events` append-only；`.meta` 保留未知键；rewrite 原子替换。
5. `subId` 双语义（int / 父 toolCallId）；磁盘路由以 `subSessionId` 为准。
6. 事件顺序契约：`snapshot` → (reasoning_started → reasoning* → tool_call → tool_result → … → content)* → usage/token_speed → complete → done；HITL choice 可中断序列。并行工具调用的所有 `tool_call` 先到达，`tool_result` 按各工具实际完成顺序逐个到达（前端按 `toolCallId` 回填，不应假设与调用顺序一致）。

# Loopra SSE 事件协议 + 持久化文件格式契约（Go 1:1 复刻目标）

> 来源：2026-10-27 从 `agent4j/loopra`（bin/session、bin/agent/output、web/service）与 `loopra-front/web/src` 前端消费侧双端提取实证。
> 配套文档：[REST API 契约](API_CONTRACT.md)。

## 0. 传输与链路

- SSE 端点：`POST /api/chat/stream`，请求体 `ChatRequest`：`{message, requestId(UUID), workspaceHash(12位md5), sessionName(默认"default"), agentId?, model?, modelChannelId?, reasoningEffort?, fastMode?, stream?(遗留不消费), images?:string[](dataURL), linkedProjectHashes?:string[], action?("execute_plan")}`。
- SSE 帧：`event: <type>\n` + `data: <json>\n\n`，UTF-8；响应头 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
- 前端解析：按 `\n` 切行去 `\r`；`event:` 行设 type；`data:` 行累积 join `\n`；空行=帧结束。data 先 JSON.parse：对象→`{...obj,type}`，字符串→`{type,content}`；`[DONE]`→`{type:'done'}`；无 `event:` 名默认 `'content'`。**没有名为 `message` 的 SSE 事件**。
- 写失败：emitter 断开后置 completed 静默丢弃后续事件，**Agent 照常执行到自然结束**。
- 建流前校验失败（body null/message 空→400 `"message 不能为空"`；action 非法→400；mergeMode 非法→400；Agent 未就绪→503 `"Agent 未初始化"`）走 HTTP；建流后错误走 SSE `error`+`done`。
- 并发准入：16 线程池 + 64 队列；重复 requestId→409 `"requestId 已有正在处理的聊天任务"`；队列满→503 `"聊天任务已满，请稍后重试"`；同 (workspace,session) 运行中→409（以上建流后经 SSE error 报告）。abort：POST /api/chat/abort 携 requestId。

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

### 1.5 模式/计划/配置
| type | data |
|---|---|
| `mode_changed` | `{"mode":"plan"\|"execute"}` |
| `plan_submitted` | `{"plan": string(markdown, null→"")}`（同时持久化 .meta.pendingPlan） |
| `config_options` | `{configOptions: [AcpConfigOption{id,name,description,category,type:"select",currentValue,options:[{id,name,description}]}]}` |
| `acp_plan` | `{entries: [{content, status:"pending"/"in_progress"/"completed", priority:"high"/"medium"/"low"(默认medium)}]}` |
| `acp_commands` | `{commands: [{name, description, inputHint: string\|null}]}` |

### 1.6 子代理事件（payload 含 `subId`；Native 为进程内自增 int 字符串化，ACP 路由时为父 toolCallId；另含 `subSessionId`：匹配 `[A-Za-z0-9_-]{1,64}` 原样，否则 SHA-256 hex = 磁盘 `.sub/{subSessionId}.jsonl` 文件名）
`sub_start{subId,subSessionId?,task,name?,title?,parentSubId?,startedAt:l}`、`sub_content{subId,token}`、`sub_reasoning{subId,token}`、`sub_reasoning_started{subId}`、`sub_tool_call{subId,toolCallId?,name,args:string}`、`sub_tool_update`、`sub_tool_result{subId,toolCallId?,name,result,status}`（并行调用时每个工具一完成就发送，同一 `toolCallId` 仅一次；`.sub` 审计日志仍按合并事件记录一次）、`sub_usage{subId,model?,promptTokens,completionTokens,totalTokens,cacheHit,cacheMiss}`、`sub_error{subId,error}`、`sub_log`、`sub_plan{subId,entries:[...]}`、`sub_complete{subId}`、`sub_end{subId,status:"completed"/"aborted"/"error",error?(仅error),endedAt:l}`。
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
  - `file_changes`: `[{path,additions,deletions,created,diff}]`、`snapshot_id`、`rollback_id`（8 位 msgId）、`web_hidden`(true 才写)、`timestamp`(ms)
  - 回合计时：`turn_started_at`/`turn_finished_at`/`elapsed_ms`；工具计时：`tool_started_at`/`tool_finished_at`/`tool_duration_ms`
  - `tool_call_id`（tool 行关联）、`tool_image_url`/`tool_image_detail`、`tool_calls`（assistant 行：`[{id(缺失→"unknown"),type:"function",function:{name,arguments:string(JSON 字符串)}}]`）、`thinking_blocks`
- 追加：逐条同步写+立即 flush；rewrite 走 `.tmp` + `Files.move(REPLACE_EXISTING)` 原子替换；**`.events` 从不重写**。
- load 跳过空行、`//` 注释行与内部通知行。

## 4. 伴生文件与目录

`hash` = 项目绝对路径 UTF-8 MD5 前 6 字节 hex（12 位）。会话簇（`{name}` 为 sanitize 基名）：
- `{name}.jsonl`：主日志（见 §3）。**延迟创建**：新建会话只切换当前会话并写 `.meta` 设置快照，首条消息写入时才创建 `.jsonl`/`.events`；会话列表只包含已写入过消息的会话（`.jsonl` 或从不重写的 `.events` 有内容；回滚截断为空也仍算），唯一例外是仅剩 `.meta` 且 `planMode=true` 或 `pendingPlan` 非空的计划会话（刷新后需能被重新发现）。旧版本遗留的“只有 0 字节 `.jsonl`、无 `.events`”空白会话不进入列表。
- `{name}.events`：**append-only 审计镜像**（append 时与 .jsonl 同步双写，rewrite 不触碰）。
- `{name}.meta`：JSON 读-改-写 + temp 原子替换，**必须保留未知键**。键：`title`、`planMode:b`、`pendingPlan`、`worktreeMode:b`、`mergeMode`(默认"manual")、`model`、`modelChannelId`、`reasoningEffort`、`agentId`(默认"native")、`acpSessionId`、`acpCwd`、`acpUsage:{used,size,cost?,currency?,model?}`、`acpPlan:[...]`、`acpCommands:[...]`、`agentConfig:{}`。
- `{name}.usage`：`{prompt,completion,cacheHit,cacheMiss,lastPromptTokens}`（long；全 0 删除）。
- `{name}.model_usage`：`{"<model>": [prompt,completion,cacheHit,cacheMiss]}`（空删除）。
- `{name}.sub/{subSessionId}.jsonl`：子代理会话（每行 `{type:"sub_*",...payload}`；subSessionId 白名单校验防穿越；缺 `sub_end` 视为运行中）。
- 项目级：`workspace/{hash}/workspace.json`（`{path,displayName:null,createdAt,lastAccessedAt}`）、`workspace/{hash}/goals/`、`workspace/{hash}/schedules/schedules.json`。
- 64 路分片锁：按文件绝对路径 hashCode 取模互斥（Go 建议 per-abs-path mutex 分片）。
- 全局：`~/.loopra/usage_daily.jsonl` 每行 `{ts(ms),model,prompt,completion,cacheHit,cacheMiss}`（全 0 不写）。

## 5. config.json 及其它配置

### 5.1 `~/.loopra/config.json`（键/类型/默认值）
`baseUrl("https://api.deepseek.com/v1")`、`apiKey`、`proxy`(旧名 proxyAddress 兼容)、`model("deepseek-v4-flash")`、`modelChannelId("default")`、`apiProtocol`(旧全局，建议渠道级)、`validationModel(+"ChannelId")`、`imageUnderstandingModel(+"ChannelId")`、`toolModel(+"ChannelId")`、`modelChannels[]`、`editMode("auto"|"yolo")`、`reasoningEffort(low/medium/high/max,默认high)`、`lang("ZH"|"EN")`、`hitl("free"|"approval"|"auto"; 旧 boolean 兼容)`、`autoWhitelist[]`(默认 32 项含 read/glob/write/ls/grep/edit/sub_agent/goal_*)、`maxContextChars(200000)`、`keepTailChars(80000)`、`contextCompaction{thresholdRatio:0.8,retainRatio:0.16,compactionRetries:1,toolResultPrune{thresholdChars:8192,headChars:4096,tailChars:1024}}`、`toolTimeoutSec(360)`、`subAgentTimeoutSec(3600)`、`maxSelfCorrectionAttempts(5)`、`maxStreamErrorRetries(10)`、`flushIntervalSec(30)`、`foldHeadCharsLimit(60000)`、`stormWindowSize(6)`、`stormThreshold(3)`、`toolResultTruncateChars(16000)`、`toolResultKeepChars(12000)`、`price{model:{input,cache,output}(每百万 RMB)}`、`disabledTools[]`、`disabledPlugins[]`、`toolReadOnlyOverrides{tool:bool}`、`blockedPaths[]`、`fastMode(false)`、`availableModels[]`、`workspaceDir`、`worktreeBaseDir(~/.loopra/worktree)`、`activePet`。
- `modelChannels[]`：`{id(缺省"channel-N"),name,baseUrl,apiKey,apiProtocol,specialCompatibility(""|deepseek|mimo|opencode),models[]}`；models 条目 `{name,displayName?,contextTokens(-1=未知),maxTokens(-1→默认),imageInput,price?{input,cache,output}}`，兼容纯字符串。
- 加载：不存在写默认；递归合并缺省；迁移工具名 task→sub_agent、goal_mark_step→goal_update_step；未配置 workspaceDir 初始化 `~/.loopra/defaultWorkSpace`。

### 5.2 其它
- `~/.loopra/agent-preferences.json`：`{selectedAgent:null, agents:{agentId:{optionId: string|boolean}}}`（排除 plan 选项）。
- `~/.loopra/agent-mcp.json`：`{agents:{agentId:{serverName: boolean}}}`。
- `mcp-servers.json`（用户级 ~/.loopra/ 与项目级 .loopra/）：Loopra 格式 `{"servers":[McpServerDTO]}` 或标准 `{"mcpServers":{name:{...}}}`（也接受裸映射；mcpServers 优先）。McpServerDTO：`{name, type:"stdio"|"sse"|"streamable"("http"/"streamable-http"→streamable; 空→有 url 无 command 即 streamable), enabled:true, command?, args?, env?, url?, headers?, timeout?("30s"/"500ms"/"2m")}`。
- `~/.loopra/mcp-server.json`：`{enabled:false, name:"loopra", version:"1.0.0", channel:"streamable"|"streamable_stateless"|"sse", endpoint:"/mcp", allowedTools:null|[string]}`（null=全部已启用，[]=不发布）。

## 6. ~/.loopra 目录清单

config.json、agent-preferences.json、agent-mcp.json、mcp-servers.json、mcp-server.json、model_meta.json、prompt-presets.json、loopra.md、usage_daily.jsonl、sessions/（无项目会话）、workspace/{hash}/（workspace.json、sessions/、goals/、schedules/）、requirements/requirements.json、skills/、extpacks/（+清单）、plugins/（+installed.json）、worktree/、chat-workspace/（纯聊天，hash=`__loopra_chat__`）、defaultWorkSpace/、pet/、logs/http/。
项目内 `.loopra/`：mcp-servers.json、skills/、read_img/、paste/、workspace/workspace.json（共享上下文）、checklists/{sessionId}.json、loopra-memory.md。

## 7. 复刻要点

1. `content`/`reasoning` 的 data 是**裸 JSON 字符串**；其余事件 data 均为 JSON 对象。
2. `error` 后必须跟 `done`；`done` 是唯一关流信号。
3. 双 usage 形态共用 `usage` 事件名，按字段存在性判别。
4. `.events` append-only；`.meta` 保留未知键；rewrite 原子替换。
5. `subId` 双语义（int / 父 toolCallId）；磁盘路由以 `subSessionId` 为准。
6. 事件顺序契约：`snapshot` → (reasoning_started → reasoning* → tool_call → tool_result → … → content)* → usage/token_speed → complete → done；HITL choice 可中断序列。并行工具调用的所有 `tool_call` 先到达，`tool_result` 按各工具实际完成顺序逐个到达（前端按 `toolCallId` 回填，不应假设与调用顺序一致）。

package app.loopra.android.chat

import app.loopra.android.data.PermissionOption
import app.loopra.android.data.StreamEvent
import org.json.JSONArray
import org.json.JSONObject

/**
 * `web/src/backend.ts` applyEvent 的忠实移植：content/reasoning 追加末尾同
 * 类型块；tool_call 按 toolCallId 建块；tool_result 按 id 回填；stream_reset
 * 只回退末尾未提交文本；sub_* 剥前缀后递归进 sub_agent 块；complete 的最终
 * 全文不与已流式内容重复。
 */
object ChatReducer {

    fun applyEvent(message: ChatMessage, event: StreamEvent): ChatMessage {
        val previous = message.blocks
        val blocks = previous.toMutableList()
        fun edit(index: Int, block: ChatBlock) { blocks[index] = block }
        val id = "${message.id}-${blocks.size}"
        val content = event.content

        when {
            event.type == "sub_choice" -> {
                blocks.add(
                    ChatBlock(
                        id = id, type = BlockType.CHOICE, subId = event.subId,
                        permissionRequestId = event.permissionRequestId,
                        question = event.string("title") ?: "子代理工具调用需要审批",
                        description = event.string("description"),
                        options = parseOptions(event),
                    ),
                )
            }
            event.type.startsWith("sub_") -> {
                val subId = "${message.id}-sub-${event.subId ?: "agent"}"
                val index = blocks.indexOfFirst { it.id == subId && it.type == BlockType.SUB_AGENT }
                var sub = if (index >= 0) blocks[index] else {
                    val created = ChatBlock(
                        id = subId, type = BlockType.SUB_AGENT,
                        name = event.string("task") ?: "子代理",
                        status = ToolStatus.RUNNING,
                    )
                    blocks.add(created)
                    created
                }
                event.string("task")?.let { sub = sub.copy(name = it) }
                when (event.type) {
                    "sub_end" -> sub = sub.copy(
                        status = if (event.string("status") == "completed") ToolStatus.SUCCESS else ToolStatus.FAILED,
                    )
                    "sub_error" -> sub = sub.copy(status = ToolStatus.FAILED)
                    "sub_start" -> { /* 仅建立子代理块 */ }
                    else -> {
                        val inner = event.copy(type = event.type.removePrefix("sub_"))
                        sub = sub.copy(
                            blocks = applyEvent(message.copy(id = subId, blocks = sub.blocks), inner).blocks,
                        )
                    }
                }
                if (index >= 0) edit(index, sub) else blocks[blocks.lastIndex] = sub
            }
            event.type == "reasoning_started" -> {
                if (blocks.lastOrNull()?.type != BlockType.REASONING_STARTED) {
                    blocks.add(ChatBlock(id = id, type = BlockType.REASONING_STARTED))
                }
            }
            event.type == "content" || event.type == "reasoning" -> {
                val type = if (event.type == "content") BlockType.CONTENT else BlockType.REASONING
                var index = blocks.lastIndex
                if (blocks.getOrNull(index)?.type != type) {
                    // 子代理插在父回合中间：父文本跨过它继续追加。
                    while (index >= 0 && blocks[index].type == BlockType.SUB_AGENT) index--
                }
                val target = blocks.getOrNull(index)
                when {
                    target?.type == type -> edit(index, target.copy(content = target.content + content))
                    target?.type == BlockType.REASONING_STARTED && type == BlockType.REASONING ->
                        edit(index, ChatBlock(id = target.id, type = BlockType.REASONING, content = content))
                    content.isNotBlank() -> blocks.add(ChatBlock(id = id, type = type, content = content))
                }
            }
            event.type == "stream_reset" -> {
                // 重试只作废当前模型片段，已完成的工具块保留。
                while (blocks.lastOrNull()?.type in setOf(
                        BlockType.CONTENT, BlockType.REASONING, BlockType.REASONING_STARTED,
                    )
                ) {
                    blocks.removeAt(blocks.lastIndex)
                }
            }
            event.type == "tool_call" -> {
                val toolCallId = event.string("toolCallId")
                val existing = toolCallId?.let { tid ->
                    blocks.indexOfFirst { it.type == BlockType.TOOL_CALL && it.toolCallId == tid }
                } ?: -1
                if (existing < 0) {
                    blocks.add(
                        ChatBlock(
                            id = id, type = BlockType.TOOL_CALL, toolCallId = toolCallId,
                            name = event.string("name") ?: "unknown",
                            status = ToolStatus.RUNNING,
                            args = argsString(event),
                        ),
                    )
                }
            }
            event.type == "tool_update" -> {
                val index = blocks.indexOfFirst {
                    it.type == BlockType.TOOL_CALL && it.toolCallId == event.string("toolCallId")
                }
                if (index >= 0) {
                    var block = blocks[index]
                    event.string("name")?.let { block = block.copy(name = it) }
                    if (event.has("args")) block = block.copy(args = argsString(event))
                    if (event.has("result")) block = block.copy(result = stringify(event.json?.opt("result")))
                    else event.string("resultDelta")?.let { block = block.copy(result = (block.result ?: "") + it) }
                    edit(index, block)
                }
            }
            event.type == "tool_result" -> {
                val toolCallId = event.string("toolCallId")
                val name = event.string("name")
                val index = blocks.indexOfLast {
                    it.type == BlockType.TOOL_CALL &&
                        if (toolCallId != null) it.toolCallId == toolCallId
                        else it.status == ToolStatus.RUNNING && (name == null || it.name == name)
                }
                if (index >= 0) {
                    val block = blocks[index]
                    val result = if (event.json != null && event.has("result")) stringify(event.json.opt("result")) else content
                    val statusText = event.string("status")
                    val status = when {
                        statusText == "running" -> ToolStatus.RUNNING
                        statusText == "failed" -> ToolStatus.FAILED
                        statusText != null -> ToolStatus.SUCCESS
                        FAILED_RESULT.containsMatchIn(result) -> ToolStatus.FAILED
                        else -> ToolStatus.SUCCESS
                    }
                    edit(
                        index,
                        block.copy(
                            result = result, status = status,
                            duration = event.json?.opt("duration")?.let { "${it}ms" } ?: block.duration,
                        ),
                    )
                }
            }
            event.type == "file_changes" && (event.array("changes")?.length() ?: 0) > 0 -> {
                val incoming = parseChanges(event.array("changes")!!)
                var index = blocks.indexOfFirst { it.type == BlockType.FILE_CHANGES }
                if (index < 0) {
                    blocks.add(ChatBlock(id = id, type = BlockType.FILE_CHANGES, changes = incoming))
                } else {
                    val merged = blocks[index].changes.toMutableList()
                    for (change in incoming) {
                        val old = merged.indexOfFirst { it.path == change.path }
                        if (old >= 0) {
                            val prev = merged[old]
                            merged[old] = prev.copy(
                                additions = prev.additions + change.additions,
                                deletions = prev.deletions + change.deletions,
                                created = prev.created || change.created,
                            )
                        } else merged.add(change)
                    }
                    edit(index, blocks[index].copy(changes = merged))
                }
            }
            event.type == "choice" && (event.array("options")?.length() ?: 0) > 0 -> {
                blocks.add(
                    ChatBlock(
                        id = id, type = BlockType.CHOICE,
                        permissionRequestId = event.permissionRequestId,
                        question = event.string("title") ?: event.string("question") ?: "请选择",
                        description = event.string("description"),
                        options = parseOptions(event),
                    ),
                )
            }
            event.type == "permission_resolved" -> {
                for (i in blocks.indices) {
                    val block = blocks[i]
                    if (block.type == BlockType.CHOICE &&
                        block.permissionRequestId == event.permissionRequestId
                    ) {
                        val title = block.options.firstOrNull { it.value == event.string("optionId") }?.title ?: "已取消"
                        edit(i, block.copy(selected = title))
                    }
                }
            }
            event.type == "elicitation" -> {
                // 表单类反向提问超出本版本范围：明确提示到桌面端处理，不静默挂起。
                blocks.add(
                    ChatBlock(
                        id = id, type = BlockType.NOTICE,
                        content = "桌面端有一个需要填写的请求，请在桌面端处理此请求",
                        name = event.string("message"),
                    ),
                )
            }
            event.type == "native_reply_stopped" -> {
                val lastContent = blocks.lastOrNull { it.type == BlockType.CONTENT }
                if (lastContent == null || !lastContent.content.trimEnd().endsWith(USER_STOPPED_REPLY)) {
                    val last = blocks.lastOrNull()
                    if (last?.type == BlockType.CONTENT) {
                        edit(blocks.lastIndex, last.copy(content = "${last.content}\n\n$USER_STOPPED_REPLY"))
                    } else {
                        blocks.add(ChatBlock(id = id, type = BlockType.CONTENT, content = USER_STOPPED_REPLY))
                    }
                }
            }
            event.type == "complete" -> {
                // 最终全文只补齐空回复；已流式的内容、工具和思考不被替换。
                if (content.isNotEmpty() && blocks.none { it.type == BlockType.CONTENT && it.content.isNotBlank() }) {
                    val note = acpStopMessage(event.string("stopReason"))
                    blocks.add(ChatBlock(id = id, type = BlockType.CONTENT, content = content + note))
                } else {
                    val note = acpStopMessage(event.string("stopReason"))
                    if (note.isNotEmpty() && blocks.none { it.type == BlockType.NOTICE && it.content == note }) {
                        blocks.add(ChatBlock(id = id, type = BlockType.NOTICE, content = note))
                    }
                }
            }
        }
        if (blocks.size == previous.size && blocks.indices.all { blocks[it] == previous[it] }) return message
        return message.copy(
            blocks = blocks,
            text = blocks.filter { it.type == BlockType.CONTENT }.joinToString("\n\n") { it.content },
        )
    }

    private fun acpStopMessage(reason: String?): String = when (reason) {
        "cancelled" -> "本次回复已停止"
        "max_tokens" -> "已达到本轮输出上限，任务可能尚未完成"
        "max_turn_requests" -> "已达到本轮请求次数上限，任务可能尚未完成"
        "refusal" -> "Agent 拒绝了本次请求"
        else -> ""
    }

    private fun stringify(value: Any?): String = when (value) {
        null, JSONObject.NULL -> ""
        is String -> value
        is JSONObject -> value.toString(2)
        is JSONArray -> value.toString(2)
        else -> value.toString()
    }

    private fun argsString(event: StreamEvent): String? {
        val raw = event.json?.opt("args") ?: event.json?.opt("arguments") ?: return null
        return when (raw) {
            is String -> raw
            else -> runCatching { (raw as? JSONObject)?.toString(2) ?: raw.toString() }.getOrNull()
        }
    }

    private fun parseOptions(event: StreamEvent): List<PermissionOption> {
        val array = event.array("options") ?: return emptyList()
        val options = mutableListOf<PermissionOption>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            options.add(
                PermissionOption(
                    title = item.optString("title").ifEmpty { item.optString("value") },
                    value = item.optString("value"),
                    kind = item.optString("kind").takeIf { it.isNotEmpty() },
                    description = item.optString("summary").takeIf { it.isNotEmpty() },
                ),
            )
        }
        return options
    }

    private fun parseChanges(array: JSONArray): List<FileChange> {
        val changes = mutableListOf<FileChange>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            changes.add(
                FileChange(
                    path = item.optString("path"),
                    additions = item.optInt("additions"),
                    deletions = item.optInt("deletions"),
                    created = item.optBoolean("created"),
                ),
            )
        }
        return changes
    }

    /**
     * `historyMessages` 的移植：tool 行按 tool_call_id 预索引；相邻 assistant
     * 行合并到同一消息直到下一个 user；隐藏 user 行与 system 行不渲染；字符串
     * 与多模态 text 片段拼接；思考与工具调用还原为流事件再归约。
     */
    fun historyMessages(raw: JSONArray): List<ChatMessage> {
        val rows = mutableListOf<JSONObject>()
        for (i in 0 until raw.length()) raw.optJSONObject(i)?.let(rows::add)
        val results = HashMap<String, JSONObject>()
        for (row in rows) {
            if (row.optString("role") == "tool" && row.optString("tool_call_id").isNotEmpty()) {
                results[row.optString("tool_call_id")] = row
            }
        }
        val messages = mutableListOf<ChatMessage>()
        var current: ChatMessage? = null
        fun push(message: ChatMessage) {
            val index = messages.indexOfFirst { it.id == message.id }
            if (index >= 0) messages[index] = message else messages.add(message)
            current = message
        }
        val timeFormat = java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA)
        rows.forEachIndexed { index, entry ->
            val role = entry.optString("role")
            val entryTime = entry.optLong("timestamp")
                .takeIf { it > 0L }
                ?.let { timeFormat.format(java.util.Date(it)) } ?: ""
            val parts = when {
                entry.optJSONArray("contentParts")?.length()?.let { it > 0 } == true -> entry.optJSONArray("contentParts")
                entry.opt("content") is JSONArray -> entry.optJSONArray("content")
                else -> null
            }
            val content = parts?.let { array ->
                (0 until array.length()).mapNotNull { i ->
                    array.optJSONObject(i)?.takeIf { it.optString("type") == "text" }?.optString("text")
                }.joinToString("\n")
            } ?: entry.optString("content").takeIf { entry.opt("content") is String } ?: ""
            when (role) {
                "user" -> {
                    current = null
                    if (!entry.optBoolean("web_hidden") && !entry.optBoolean("webHidden")) {
                        messages.add(
                            ChatMessage(
                                id = "history-$index",
                                role = Role.USER,
                                text = content,
                                time = entryTime,
                            ),
                        )
                    }
                }
                "assistant" -> {
                    val message = current ?: ChatMessage(
                        id = "history-$index", role = Role.ASSISTANT, time = entryTime,
                    ).also { messages.add(it) }
                    current = message
                    val events = mutableListOf<StreamEvent>()
                    val reasoning = entry.optString("reasoning_content")
                    if (reasoning.isNotEmpty()) events.add(StreamEvent.text("reasoning", reasoning))
                    if (hasEncryptedReasoning(entry.opt("response_reasoning") ?: entry.opt("responseReasoning"))) {
                        events.add(StreamEvent("reasoning_started", JSONObject()))
                    }
                    entry.optJSONArray("tool_calls")?.let { calls ->
                        for (i in 0 until calls.length()) {
                            val call = calls.optJSONObject(i) ?: continue
                            val function = call.optJSONObject("function")
                            val name = function?.optString("name")?.ifEmpty { null }
                                ?: call.optString("name").ifEmpty { "unknown" }
                            val callId = call.optString("id")
                            val args = function?.opt("arguments") ?: call.opt("arguments")
                            val toolCall = JSONObject()
                            toolCall.put("toolCallId", callId)
                            toolCall.put("name", name)
                            if (args != null) toolCall.put("args", args)
                            events.add(StreamEvent("tool_call", toolCall))
                            results[callId]?.let { result ->
                                val toolResult = JSONObject()
                                toolResult.put("toolCallId", callId)
                                toolResult.put("name", name)
                                toolResult.put("result", result.opt("content") ?: "")
                                if (result.has("tool_status")) toolResult.put("status", result.optString("tool_status"))
                                if (result.has("tool_duration_ms")) toolResult.put("duration", result.opt("tool_duration_ms"))
                                events.add(StreamEvent("tool_result", toolResult))
                            }
                        }
                    }
                    if (content.isNotBlank()) events.add(StreamEvent.text("content", content))
                    (entry.optJSONArray("file_changes") ?: entry.optJSONArray("fileChanges"))?.let { changes ->
                        val fileChanges = JSONObject()
                        fileChanges.put("changes", changes)
                        events.add(StreamEvent("file_changes", fileChanges))
                    }
                    var updated = message
                    for (event in events) updated = applyEvent(updated, event)
                    push(updated)
                }
            }
        }
        return messages
    }

    /** 存储回合里存在加密思考（不可见）时，只打开占位槽。 */
    private fun hasEncryptedReasoning(value: Any?): Boolean {
        val item = when (value) {
            is JSONObject -> value
            is String -> runCatching { JSONObject(value) }.getOrNull()
            else -> null
        } ?: return false
        return item.optString("type") == "reasoning" &&
            item.optString("encrypted_content").isNotEmpty()
    }

    private val FAILED_RESULT = Regex("^(错误|Error|Exception|\\[failed\\])", RegexOption.IGNORE_CASE)
}

package app.loopra.android.data

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.json.JSONArray
import org.json.JSONObject

class ApiException(message: String, val status: Int? = null, val reason: String? = null) : Exception(message)

/** 流在 done/complete 之前意外结束：界面需要标为中断并走历史恢复。 */
class StreamInterruptedException(message: String = "连接意外中断，回复可能不完整") : Exception(message)

/** 已建立的流中途由服务端 error 事件终止；与 HTTP 握手失败（ApiException）区分。 */
class StreamFailedException(message: String, val reason: String? = null) : Exception(message)

private object StreamDone : Exception()

data class Workspace(val hash: String, val name: String, val path: String, val displayName: String? = null) {
    companion object {
        /** 与桌面端 CHAT_WORKSPACE 一致的纯聊天虚拟工作区。 */
        val CHAT = Workspace("__loopra_chat__", "纯聊天", "")
    }
}

data class RemoteSession(
    val name: String,
    val title: String,
    val mtime: Long,
    val messageCount: Int,
    val agentId: String?,
    val customAgentId: String?,
)

data class PreparedSession(
    val sessionName: String,
    val agentId: String,
    /** prepare 响应附带的引擎配置；缺席时保持 null，由界面按需再取。 */
    val configOptions: List<AgentConfigOption>? = null,
)

data class SessionStatus(val running: Boolean, val requestId: String?, val title: String?)

data class PermissionOption(val title: String, val value: String, val kind: String?, val description: String?)

data class PermissionChoice(
    val permissionRequestId: String,
    val title: String,
    val description: String?,
    val options: List<PermissionOption>,
)

/**
 * 通过单个 RelayConnection 访问桌面 /api/。所有方法都显式携带
 * workspaceHash / sessionName 作用域，浏览不同会话不需要切换后端状态。
 */
class LoopraRepository(private val connection: RelayConnection) : LoopraApi {
    override suspend fun workspaces(): List<Workspace> {
        val data = request("/api/workspaces") as? JSONArray ?: return listOf(Workspace.CHAT)
        val list = mutableListOf(Workspace.CHAT)
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val hash = item.optString("hash")
            if (hash.isEmpty() || hash == Workspace.CHAT.hash) continue
            list.add(
                Workspace(
                    hash = hash,
                    name = item.optString("name").ifEmpty { item.optString("path") },
                    path = item.optString("path"),
                    displayName = item.optString("displayName").takeIf { it.isNotEmpty() },
                ),
            )
        }
        return list
    }

    override suspend fun sessions(workspaceHash: String): List<RemoteSession> {
        val path = "/api/sessions?workspaceHash=${encode(workspaceHash)}"
        val data = request(path) as? JSONArray ?: return emptyList()
        val list = mutableListOf<RemoteSession>()
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val name = item.optString("name")
            if (name.isEmpty()) continue
            list.add(
                RemoteSession(
                    name = name,
                    title = item.optString("title").ifEmpty { name },
                    mtime = item.optLong("mtime"),
                    messageCount = item.optInt("messageCount"),
                    agentId = item.optString("agentId").ifEmpty { "native" },
                    customAgentId = item.optString("customAgentId").takeIf { it.isNotEmpty() },
                ),
            )
        }
        return list.sortedByDescending { it.mtime }
    }

    override suspend fun prepare(workspaceHash: String, agentId: String): PreparedSession {
        val body = JSONObject()
        body.put("workspaceHash", workspaceHash)
        body.put("agentId", agentId.ifEmpty { "native" })
        val data = request("/api/agent-engines/prepare", "POST", body) as? JSONObject
            ?: throw ApiException("会话创建失败")
        val name = data.optString("sessionName")
        if (name.isEmpty()) throw ApiException("会话创建失败")
        return PreparedSession(
            sessionName = name,
            agentId = data.optString("agentId").ifEmpty { "native" },
            configOptions = data.optJSONArray("configOptions")?.let { ReplyConfig.parse(it) },
        )
    }

    override suspend fun agentEngines(): List<AgentEngine> {
        val data = request("/api/agent-engines") as? JSONArray ?: return emptyList()
        val list = mutableListOf<AgentEngine>()
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val id = item.optString("id")
            if (id.isEmpty()) continue
            list.add(
                AgentEngine(
                    id = id,
                    name = item.optString("name").ifEmpty { id },
                    available = item.optBoolean("available", true),
                    hidden = item.optBoolean("hidden"),
                ),
            )
        }
        return list
    }

    override suspend fun elicitations(workspaceHash: String, sessionName: String): List<ElicitationRequest> {
        val path = "/api/chat/elicitations?workspaceHash=${encode(workspaceHash)}&sessionName=${encode(sessionName)}"
        val data = request(path) as? JSONArray ?: return emptyList()
        val list = mutableListOf<ElicitationRequest>()
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            ElicitationRequest.parse(item)?.let(list::add)
        }
        return list
    }

    override suspend fun answerElicitation(
        workspaceHash: String,
        sessionName: String,
        elicitationRequestId: String,
        action: String,
        content: Map<String, Any>,
    ) {
        val body = JSONObject()
        body.put("workspaceHash", workspaceHash)
        body.put("sessionName", sessionName)
        body.put("elicitationRequestId", elicitationRequestId)
        body.put("action", action)
        val json = JSONObject()
        for ((key, value) in content) {
            when (value) {
                is List<*> -> json.put(key, JSONArray(value))
                else -> json.put(key, value)
            }
        }
        body.put("content", json)
        request("/api/chat/elicitation", "POST", body)
    }

    override suspend fun replyConfig(workspaceHash: String, sessionName: String): List<AgentConfigOption> {
        val path = "/api/agent-engines/config?workspaceHash=${encode(workspaceHash)}&sessionName=${encode(sessionName)}"
        val data = request(path) as? JSONObject ?: throw ApiException("无法读取回复设置")
        return ReplyConfig.parse(data)
    }

    override suspend fun updateReplyConfig(
        workspaceHash: String,
        sessionName: String,
        configId: String,
        value: ConfigValue,
    ): List<AgentConfigOption> {
        val body = JSONObject()
        body.put("workspaceHash", workspaceHash)
        body.put("sessionName", sessionName)
        body.put("configId", configId)
        when (value) {
            is ConfigValue.Text -> body.put("value", value.value)
            is ConfigValue.Toggle -> body.put("value", value.value)
        }
        val data = request("/api/agent-engines/config", "PUT", body) as? JSONObject
            ?: throw ApiException("回复设置保存失败")
        return ReplyConfig.parse(data)
    }

    override suspend fun history(workspaceHash: String, sessionName: String): JSONArray {
        val path = "/api/agent/history?workspaceHash=${encode(workspaceHash)}&sessionName=${encode(sessionName)}"
        return request(path) as? JSONArray ?: JSONArray()
    }

    override suspend fun sessionStatus(workspaceHash: String, sessionName: String): SessionStatus {
        val path = "/api/agent/session-status?workspaceHash=${encode(workspaceHash)}&sessionName=${encode(sessionName)}"
        val data = request(path) as? JSONObject ?: return SessionStatus(false, null, null)
        return SessionStatus(
            running = data.optBoolean("running"),
            requestId = data.optString("requestId").takeIf { it.isNotEmpty() },
            title = data.optString("title").takeIf { it.isNotEmpty() },
        )
    }

    override suspend fun permissions(workspaceHash: String, sessionName: String): List<PermissionChoice> {
        val path = "/api/chat/permissions?workspaceHash=${encode(workspaceHash)}&sessionName=${encode(sessionName)}"
        val data = request(path) as? JSONArray ?: return emptyList()
        val list = mutableListOf<PermissionChoice>()
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val id = item.optString("permissionRequestId")
            if (id.isEmpty()) continue
            val options = mutableListOf<PermissionOption>()
            item.optJSONArray("options")?.let { array ->
                for (j in 0 until array.length()) {
                    val option = array.optJSONObject(j) ?: continue
                    options.add(
                        PermissionOption(
                            title = option.optString("title").ifEmpty { option.optString("value") },
                            value = option.optString("value"),
                            kind = option.optString("kind").takeIf { it.isNotEmpty() },
                            description = option.optString("summary").takeIf { it.isNotEmpty() },
                        ),
                    )
                }
            }
            list.add(
                PermissionChoice(
                    permissionRequestId = id,
                    title = item.optString("title").ifEmpty { "工具调用需要审批" },
                    description = item.optString("description").takeIf { it.isNotEmpty() },
                    options = options,
                ),
            )
        }
        return list
    }

    override suspend fun resolvePermission(
        workspaceHash: String,
        sessionName: String,
        permissionRequestId: String,
        optionId: String,
    ) {
        val body = JSONObject()
        body.put("workspaceHash", workspaceHash)
        body.put("sessionName", sessionName)
        body.put("permissionRequestId", permissionRequestId)
        body.put("optionId", optionId)
        request("/api/chat/permission", "POST", body)
    }

    override suspend fun abort(workspaceHash: String, sessionName: String, requestId: String) {
        val body = JSONObject()
        body.put("workspaceHash", workspaceHash)
        body.put("sessionName", sessionName)
        body.put("requestId", requestId)
        request("/api/chat/abort", "POST", body)
    }

    override fun chatStream(body: JSONObject, requestId: String): Flow<StreamEvent> = flow {
        val transportId = "req-${UUID.randomUUID()}"
        try {
            val head = connection.send(
                RelayRequest(
                    id = transportId,
                    path = "/api/chat/stream",
                    method = "POST",
                    headers = mapOf(
                        "content-type" to "application/json",
                        "accept" to "text/event-stream",
                        "x-request-id" to requestId,
                    ),
                    body = body.toString().toByteArray(StandardCharsets.UTF_8),
                ),
            )
            if (head.status != 200 || !head.contentType.contains("text/event-stream")) {
                val errorBody = runCatching { collectBody(transportId, MAX_ERROR_BYTES) }.getOrNull()
                throw apiError(head, errorBody)
            }
            val decoder = Utf8StreamDecoder()
            var completed = false
            var terminalReply = false
            // 解析是同步回调；帧先排队再由收集方背压式 emit，
            // 避免无缓冲 trySend 在单块携带大量事件时静默丢弃。
            val frames = ArrayDeque<StreamEvent>()
            val parser = SseParser { event ->
                if (!completed) {
                    frames.add(event)
                    if (event.type == "done") completed = true
                }
            }
            suspend fun drain() {
                while (frames.isNotEmpty()) {
                    val event = frames.removeFirst()
                    if (event.type == "complete" ||
                        (event.type == "choice" && event.permissionRequestId == null)
                    ) {
                        terminalReply = true
                    }
                    if (event.type == "stream_reset") terminalReply = false
                    emit(event)
                    if (event.type == "error") {
                        throw StreamFailedException(
                            event.string("error") ?: event.text ?: "回合失败",
                            event.string("reason"),
                        )
                    }
                    if (event.type == "done") {
                        frames.clear() // done 之后的尾随事件不再处理
                        return
                    }
                }
            }
            try {
                connection.readBody(transportId).collect { chunk ->
                    parser.push(decoder.decode(chunk))
                    drain()
                    // done 之后立即停止读取并释放隧道内请求，与网页端 reader.cancel 一致。
                    if (completed) throw StreamDone
                }
            } catch (done: StreamDone) {
                // 正常收到 done 后主动停止读取。
            }
            if (!completed) {
                parser.push(decoder.decode(ByteArray(0), end = true), end = true)
                drain()
            }
            if (!completed && !terminalReply) throw StreamInterruptedException()
        } finally {
            // 停止隧道内这个 HTTP 请求的字节流；桌面端回合是否继续由
            // /api/chat/abort 单独决定，这里绝不取消后端任务。
            connection.cancel(transportId)
        }
    }

    private suspend fun collectBody(transportId: String, limit: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        connection.readBody(transportId).collect { chunk ->
            if (output.size() + chunk.size > limit) throw ApiException("响应超过大小限制")
            output.write(chunk)
        }
        return output.toByteArray()
    }

    private fun apiError(head: ResponseHead, body: ByteArray?): ApiException {
        val envelope = body?.let { runCatching { JSONObject(String(it, StandardCharsets.UTF_8)) }.getOrNull() }
        val message = envelope?.optString("error")?.takeIf { it.isNotEmpty() }
            ?: envelope?.optString("message")?.takeIf { it.isNotEmpty() }
            ?: "无法建立聊天流（HTTP ${head.status}）"
        return ApiException(message, head.status, envelope?.optString("reason")?.takeIf { it.isNotEmpty() })
    }

    companion object {
        private const val MAX_BODY_BYTES = 16 shl 20
        private const val MAX_ERROR_BYTES = 1 shl 20

        // Charset 重载需要 API33；用名字符串兼容 minSdk 24。
        fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")
    }

    /**
     * 常规 JSON 请求：解 {success, data} 信封，失败抛 ApiException。
     * 响应体上限 16MiB，与隧道层一致。
     */
    private suspend fun request(path: String, method: String = "GET", body: JSONObject? = null): Any? {
        val transportId = "req-${UUID.randomUUID()}"
        val headers = mutableMapOf("accept" to "application/json")
        if (body != null) headers["content-type"] = "application/json"
        try {
            val head = connection.send(
                RelayRequest(
                    id = transportId,
                    path = path,
                    method = method,
                    headers = headers,
                    body = body?.toString()?.toByteArray(StandardCharsets.UTF_8) ?: ByteArray(0),
                ),
            )
            val raw = collectBody(transportId, MAX_BODY_BYTES)
            val envelope = runCatching { JSONObject(String(raw, StandardCharsets.UTF_8)) }.getOrNull()
                ?: throw ApiException("Loopra 返回了无效响应（HTTP ${head.status}）", head.status)
            if (head.status !in 200..299 || !envelope.optBoolean("success")) {
                throw ApiException(
                    envelope.optString("error").ifEmpty { "HTTP ${head.status}" },
                    head.status,
                    envelope.optString("reason").takeIf { it.isNotEmpty() },
                )
            }
            return if (envelope.has("data")) envelope.get("data") else null
        } finally {
            connection.cancel(transportId)
        }
    }
}

/** ViewModel 依赖的 API 面，测试中替换为假实现。 */
interface LoopraApi {
    suspend fun workspaces(): List<Workspace>
    suspend fun sessions(workspaceHash: String): List<RemoteSession>
    suspend fun prepare(workspaceHash: String, agentId: String = "native"): PreparedSession
    suspend fun history(workspaceHash: String, sessionName: String): JSONArray
    suspend fun sessionStatus(workspaceHash: String, sessionName: String): SessionStatus
    suspend fun permissions(workspaceHash: String, sessionName: String): List<PermissionChoice>
    suspend fun resolvePermission(workspaceHash: String, sessionName: String, permissionRequestId: String, optionId: String)
    suspend fun abort(workspaceHash: String, sessionName: String, requestId: String)
    suspend fun agentEngines(): List<AgentEngine>
    suspend fun elicitations(workspaceHash: String, sessionName: String): List<ElicitationRequest>
    suspend fun answerElicitation(
        workspaceHash: String,
        sessionName: String,
        elicitationRequestId: String,
        action: String,
        content: Map<String, Any>,
    )
    suspend fun replyConfig(workspaceHash: String, sessionName: String): List<AgentConfigOption>
    suspend fun updateReplyConfig(
        workspaceHash: String,
        sessionName: String,
        configId: String,
        value: ConfigValue,
    ): List<AgentConfigOption>
    fun chatStream(body: JSONObject, requestId: String): Flow<StreamEvent>
}

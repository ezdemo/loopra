package app.loopra.android.data

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

/** 一次中继隧道内 HTTP 请求。字段与既有契约一致，序列化在 RelayClient 内部完成。 */
data class RelayRequest(
    val id: String,
    val path: String,
    val method: String = "GET",
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray = ByteArray(0),
)

data class ResponseHead(val status: Int, val headers: Map<String, String>) {
    val contentType: String
        get() = headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value ?: ""
}

/** 连接状态快照：connecting | connected | disconnected | closed。 */
data class RelayStatus(val state: String, val error: String?, val revision: Long)

/**
 * 一个配对对应一个连接。纯 Kotlin 实现：OkHttp WebSocket + JCA E2E 加密，
 * 传输语义与 `mobile/src-tauri/relay-core`（Rust `Client`）逐条对齐。
 * 挂起的协程取消会立即向隧道发送 hcancel 释放对端 pending，而不是等读超时。
 */
interface RelayConnection : Closeable {
    val pairing: Pairing
    fun statusNow(): RelayStatus
    suspend fun check()
    suspend fun send(request: RelayRequest): ResponseHead
    /** 分块读取响应体；正常结束时 Flow 完成，取消时仅取消隧道内请求。 */
    fun readBody(requestId: String): Flow<ByteArray>
    /** 仅停止该请求的字节流；不会终止桌面端已开始的回合。 */
    fun cancel(requestId: String)
    override fun close()
}

/** 连接各阶段时限；测试可以注入更短的值。 */
internal class RelayTiming(
    val establishMs: Long = 25_000,
    val probeTimeoutMs: Long = 10_000,
    val probeIntervalMs: Long = 20_000,
    val livenessMs: Long = 60_000,
    val responseHeadMs: Long = 60_000,
    val checkMs: Long = 35_000,
    val backoffMs: LongArray = longArrayOf(900, 2_200, 5_000, 10_000, 30_000),
)

private class TunnelException(message: String) : Exception(message)

class RelayClient internal constructor(
    pairing: Pairing,
    private val socketFactory: RelaySocketFactory =
        OkHttpSocketFactory(OkHttpSocketFactory.defaultClient()),
    private val timing: RelayTiming = RelayTiming(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) : RelayConnection {

    // 构造时重新校验配对：HTTPS 根地址或本机回环 HTTP、32 字节规范连接码。
    override val pairing: Pairing = Pairing.validate(
        pairing.relayUrl, pairing.connectCode, pairing.version, pairing.displayName,
    )

    private val monitor = Any()
    private var closed = false
    private var connected = false
    private var current: Attempt? = null
    private val statusFlow = MutableStateFlow(RelayStatus("connecting", null, 0))
    private var healthChecks = 0L
    private var healthSignal = CompletableDeferred<Unit>()
    private val nudges = Channel<Unit>(Channel.CONFLATED)
    private val pending = HashMap<String, Pending>()
    private var bufferedBytes = 0
    private val cancelled = ArrayDeque<String>()

    init {
        scope.launch { run() }
    }

    // ---- 公共契约 ------------------------------------------------------------

    override fun statusNow(): RelayStatus = statusFlow.value

    override suspend fun check() {
        val (revision, checks) = synchronized(monitor) {
            statusFlow.value.revision to healthChecks
        }
        nudges.trySend(Unit)
        try {
            withTimeout(timing.checkMs) {
                while (true) {
                    val signal = synchronized(monitor) {
                        if (closed) throw IllegalStateException("连接已关闭")
                        val advanced = healthChecks != checks ||
                            (statusFlow.value.state == "connected" &&
                                statusFlow.value.revision > revision)
                        if (advanced) null else healthSignal
                    } ?: return@withTimeout
                    signal.await()
                }
            }
        } catch (timeout: TimeoutCancellationException) {
            throw IllegalStateException("连接仍在恢复，将继续自动重连")
        }
    }

    override suspend fun send(request: RelayRequest): ResponseHead {
        validate(request)
        val entry = synchronized(monitor) {
            if (closed) throw IllegalStateException("连接已关闭")
            val attempt = current
            if (!connected || attempt == null || attempt.dead) {
                throw IllegalStateException("桌面已断开，正在重新连接")
            }
            if (cancelled.contains(request.id)) throw IllegalStateException("请求已取消")
            // 隧道允许 64 个并发请求，为端到端健康探测预留一个名额。
            if (pending.size >= 63 || pending.containsKey(request.id)) {
                throw IllegalStateException("请求过多或请求标识重复")
            }
            Pending(attempt, request.method).also { pending[request.id] = it }
        }
        try {
            val head = withTimeout(timing.responseHeadMs) {
                // 编码/加密放到 IO 上下文，避免在调用方（通常是 Main）上做重活。
                val sent = withContext(Dispatchers.IO) {
                    val frame = JSONObject()
                        .put("t", "hreq")
                        .put("id", request.id)
                        .put("method", request.method)
                        .put("path", request.path)
                        .put("headers", JSONObject(request.headers))
                        .put("b", RelayCodec.encode(request.body))
                    synchronized(monitor) {
                        if (!closed && pending[request.id] === entry) {
                            sendFrame(entry.attempt, frame)
                        } else {
                            false
                        }
                    }
                }
                if (!sent) throw IllegalStateException("桌面已断开，正在重新连接")
                entry.head.await()
            }
            return head
        } catch (timeout: TimeoutCancellationException) {
            cancelRequest(request.id, entry)
            throw IllegalStateException("桌面响应超时")
        } catch (cancelled: CancellationException) {
            cancelRequest(request.id, entry)
            throw cancelled
        } catch (error: Exception) {
            // herr / 断连 / 发送失败等所有路径都必须释放 pending 名额。
            cancelRequest(request.id, entry)
            throw error
        }
    }

    override fun readBody(requestId: String): Flow<ByteArray> = flow {
        // 一次捕获本请求的 pending：之后不再按 id 查询，避免命中后续同名条目。
        val entry = synchronized(monitor) { pending[requestId] }
            ?: throw IllegalStateException("请求已取消")
        try {
            while (true) {
                when (val step = readStep(requestId, entry)) {
                    is ReadStep.Data -> emit(step.bytes)
                    is ReadStep.WaitFor -> step.wake.receive()
                    is ReadStep.Fail -> throw IllegalStateException(step.message)
                    ReadStep.Eof -> break
                }
            }
        } finally {
            // 自然 EOF 时条目已移除，不会发多余 hcancel；收集中途取消则释放对端。
            cancelRequest(requestId, entry)
        }
    }

    override fun cancel(requestId: String) {
        val attempt = synchronized(monitor) {
            if (pending[requestId] == null) {
                // 支持先于 send 的取消：标记后同 id 请求直接拒绝。
                cancelled.addLast(requestId)
                while (cancelled.size > 256) cancelled.removeFirst()
                return@synchronized null
            }
            cancelRequestLocked(requestId, null)
        }
        attempt?.let {
            sendFrame(it, JSONObject().put("t", "hcancel").put("id", requestId))
        }
    }

    override fun close() {
        val attempt = synchronized(monitor) {
            if (closed) return
            closed = true
            val attempt = current
            current = null
            attempt?.dead = true
            attempt?.failureReason = "连接已关闭"
            attempt?.failure?.complete("连接已关闭")
            attempt?.probe?.timer?.cancel()
            failPendingLocked("连接已关闭")
            statusFlow.value = RelayStatus("closed", null, statusFlow.value.revision + 1)
            healthSignal.complete(Unit)
            healthSignal = CompletableDeferred()
            attempt
        }
        runCatching { attempt?.socket?.cancel() }
        scope.cancel()
    }

    // ---- 连接主循环 ------------------------------------------------------------

    private suspend fun run() {
        var failures = 0
        while (true) {
            val attempt = synchronized(monitor) {
                if (closed) return
                Attempt().also { current = it; publishLocked("connecting", null) }
            }
            var error: String
            try {
                withTimeout(timing.establishMs) { establish(attempt) }
                failures = 0
                error = serve(attempt)
            } catch (timeout: TimeoutCancellationException) {
                error = "桌面连接超时，请确认桌面在线且网络可达"
            } catch (tunnel: TunnelException) {
                error = tunnel.message ?: "无法连接中继，请检查网络和 HTTPS 域名"
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (unexpected: Exception) {
                error = "无法连接中继，请检查网络和 HTTPS 域名"
            }
            try {
                synchronized(monitor) {
                    if (current === attempt) current = null
                    attempt.dead = true
                    attempt.probe?.timer?.cancel()
                    connected = false
                    failPendingLocked(error)
                }
                runCatching { attempt.socket?.cancel() }
                if (closed) break
                if (isFatal(error)) {
                    synchronized(monitor) {
                        // 先发布终态再落 closed，让 check() 等待者立刻拿到终态。
                        publishLocked("closed", error)
                        closed = true
                    }
                    break
                }
                publish("disconnected", error)
                // 有界退避，断线期间持续恢复；check() 的 nudge 立即重连并重置退避。
                val delayMs = timing.backoffMs[failures.coerceAtMost(timing.backoffMs.lastIndex)]
                failures++
                val resumed = withTimeoutOrNull(delayMs) {
                    nudges.receive()
                    true
                } == true
                if (resumed) failures = 0
            } finally {
                attempt.probe?.timer?.cancel()
                runCatching { attempt.socket?.cancel() }
            }
        }
        synchronized(monitor) { failPendingLocked("连接已关闭") }
        if (statusNow().state != "closed") publish("closed", null)
    }

    // ---- 建连 ------------------------------------------------------------------

    private suspend fun establish(attempt: Attempt) {
        try {
            val route = RelayCodec.routingId(pairing.connectCode)
            val url = pairing.relayUrl.toHttpUrl().newBuilder()
                .addPathSegments("c/$route/__loopra_e2e__/v1")
                .build()
            val socket = socketFactory.open(url.toString(), listenerFor(attempt))
            synchronized(monitor) {
                when {
                    closed || attempt.dead || attempt !== current -> socket.cancel()
                    attempt.socket == null -> attempt.socket = socket
                }
            }
            val handshake = RelayHandshake()
            if (!sendText(attempt, handshake.hello().toString())) {
                throw TunnelException("无法连接中继，请检查网络和 HTTPS 域名")
            }
            val raw = attempt.awaitInbox() as? String
                ?: throw TunnelException("桌面握手数据无效")
            val hello = try {
                JSONObject(raw)
            } catch (error: Exception) {
                throw TunnelException("桌面握手数据无效")
            }
            val result = try {
                handshake.finish(pairing.connectCode, hello)
            } catch (error: RelayCryptoException) {
                throw TunnelException(error.message ?: "桌面握手数据无效")
            }
            synchronized(monitor) {
                if (closed || attempt.dead || attempt !== current) {
                    throw TunnelException("中继已断开，正在重新连接")
                }
                attempt.session = result.session
            }
            if (!sendText(attempt, result.confirm.toString())) {
                throw TunnelException("中继发送失败")
            }
            // 可用连接包含应用协议检查，重连后同样重新验证。
            if (!sendFrame(
                    attempt,
                    JSONObject()
                        .put("t", "hreq")
                        .put("id", "__handshake")
                        .put("method", "GET")
                        .put("path", "/api/mobile/handshake"),
                )
            ) {
                throw TunnelException("中继发送失败")
            }
            val body = ByteArrayOutputStream()
            var headers = false
            while (true) {
                val frame = attempt.awaitInbox() as? JSONObject
                    ?: throw TunnelException("隧道响应无效")
                if (frame.opt("id") != "__handshake") {
                    throw TunnelException("桌面协议验证失败")
                }
                when (frame.opt("t")) {
                    "hres" -> {
                        val status = optInt(frame, "status")
                        if (!headers && status == 200) headers = true
                        else throw TunnelException("桌面协议验证失败")
                    }
                    "hchunk" -> {
                        if (!headers) throw TunnelException("桌面协议验证失败")
                        val b64 = frame.opt("b") as? String
                            ?: throw TunnelException("桌面协议验证失败")
                        if (b64.length > B64_CHUNK_LIMIT) {
                            throw TunnelException("桌面协议验证失败")
                        }
                        body.write(
                            try {
                                RelayCodec.decode(b64)
                            } catch (error: RelayCryptoException) {
                                throw TunnelException("桌面协议验证失败")
                            },
                        )
                        if (body.size() > CHUNK_LIMIT) {
                            throw TunnelException("桌面协议验证失败")
                        }
                    }
                    "hend" -> {
                        if (!headers) throw TunnelException("桌面协议验证失败")
                        val data = try {
                            JSONObject(String(body.toByteArray(), Charsets.UTF_8))
                        } catch (error: Exception) {
                            throw TunnelException("桌面协议验证失败")
                        }
                        val fields = data.optJSONObject("data")
                        if (!data.optBoolean("success") ||
                            fields?.optString("protocol") != "loopra-relay" ||
                            optInt(fields, "version") != 1
                        ) {
                            throw TunnelException("桌面尚未支持 Loopra Mobile，请更新桌面端后重新配对")
                        }
                        synchronized(monitor) {
                            if (closed || attempt.dead || attempt !== current) {
                                throw TunnelException("中继已断开，正在重新连接")
                            }
                            attempt.ready = true
                            connected = true
                            publishLocked("connected", null)
                        }
                        return
                    }
                    else -> throw TunnelException("桌面协议验证失败")
                }
            }
        } catch (error: Exception) {
            synchronized(monitor) {
                attempt.dead = true
                attempt.failureReason =
                    (error as? TunnelException)?.message ?: "中继已断开，正在重新连接"
                attempt.failure.complete(attempt.failureReason!!)
            }
            runCatching { attempt.socket?.cancel() }
            throw error
        }
    }

    // ---- 服务循环 ----------------------------------------------------------------

    /** 返回断开原因；心跳/探测/手动检查都按当前 attempt 身份校验后再动作。 */
    private suspend fun serve(attempt: Attempt): String {
        val ticker = scope.launch {
            while (isActive) {
                delay(timing.probeIntervalMs)
                synchronized(monitor) {
                    if (closed || attempt.dead || attempt !== current) return@launch
                    val idleMs = TimeUnit.NANOSECONDS.toMillis(
                        System.nanoTime() - attempt.lastMessageNanos,
                    )
                    if (idleMs > timing.livenessMs) {
                        failAttemptLocked(attempt, "中继连接已失活，正在重新连接")
                        return@launch
                    }
                    if (attempt.probe == null) startProbeLocked(attempt)
                }
            }
        }
        val nudger = scope.launch {
            while (isActive) {
                nudges.receive()
                synchronized(monitor) {
                    if (closed || attempt.dead || attempt !== current) return@launch
                    if (attempt.probe == null) startProbeLocked(attempt)
                }
            }
        }
        try {
            return attempt.failure.await()
        } finally {
            ticker.cancel()
            nudger.cancel()
        }
    }

    /** 探测真实桌面 API：中继能回 WS Ping 不代表桌面隧道活着。 */
    private fun startProbeLocked(attempt: Attempt) {
        val probe = Probe()
        // 先登记再发送：同步应答链路（测试假 socket）可能在本帧内就回包。
        attempt.probe = probe
        if (!sendFrame(
                attempt,
                JSONObject()
                    .put("t", "hreq")
                    .put("id", "__probe")
                    .put("method", "HEAD")
                    .put("path", "/api/mobile/handshake"),
            )
        ) {
            if (attempt.probe === probe) attempt.probe = null
            return
        }
        probe.timer = scope.launch {
            delay(timing.probeTimeoutMs)
            synchronized(monitor) {
                if (!closed && !attempt.dead && attempt === current && attempt.probe === probe) {
                    failAttemptLocked(attempt, "桌面连接检查超时，正在重新连接")
                }
            }
        }
    }

    private fun probeFrameLocked(attempt: Attempt, frame: JSONObject, kind: String) {
        val probe = attempt.probe ?: run {
            failAttemptLocked(attempt, "连接检查响应顺序无效")
            return
        }
        when (kind) {
            "hres" -> {
                if (!probe.headers && optInt(frame, "status") == 200) {
                    probe.headers = true
                } else {
                    failAttemptLocked(attempt, "桌面连接检查响应无效")
                }
            }
            "hchunk" -> {
                if (!probe.headers) {
                    failAttemptLocked(attempt, "桌面连接检查响应无效")
                    return
                }
                val b64 = frame.opt("b") as? String
                if (b64 == null || b64.length > B64_CHUNK_LIMIT) {
                    failAttemptLocked(attempt, "连接检查响应编码无效")
                    return
                }
                val chunk = try {
                    RelayCodec.decode(b64)
                } catch (error: RelayCryptoException) {
                    failAttemptLocked(attempt, "连接检查响应编码无效")
                    return
                }
                probe.received += chunk.size
                if (probe.received > CHUNK_LIMIT) {
                    failAttemptLocked(attempt, "连接检查响应过大")
                }
            }
            "hend" -> {
                if (!probe.headers) {
                    failAttemptLocked(attempt, "桌面连接检查响应无效")
                    return
                }
                probe.timer?.cancel()
                attempt.probe = null
                healthChecks++
                healthSignal.complete(Unit)
                healthSignal = CompletableDeferred()
            }
            else -> failAttemptLocked(attempt, "桌面连接检查响应无效")
        }
    }

    // ---- 响应帧分发 --------------------------------------------------------------

    private fun listenerFor(attempt: Attempt) = object : RelaySocketListener {
        override fun onOpen(socket: RelaySocket) {
            synchronized(monitor) {
                if (closed || attempt.dead || attempt !== current) {
                    socket.cancel()
                } else if (attempt.socket == null) {
                    attempt.socket = socket
                }
            }
        }

        override fun onText(text: String) {
            synchronized(monitor) {
                if (closed || attempt.dead || attempt !== current) return
                attempt.lastMessageNanos = System.nanoTime()
                if (attempt.session != null || attempt.ready) {
                    failAttemptLocked(attempt, "隧道响应无效")
                    return
                }
                val size = text.toByteArray(Charsets.UTF_8).size
                if (size > 16_384 ||
                    attempt.inbox.size >= 32 ||
                    attempt.inboxBytes + size > 128 * 1024
                ) {
                    failAttemptLocked(attempt, "桌面握手数据无效")
                    return
                }
                attempt.inbox.addLast(InboxItem(text, size))
                attempt.inboxBytes += size
                attempt.inboxSignal.trySend(Unit)
            }
        }

        override fun onBinary(bytes: ByteArray) {
            synchronized(monitor) {
                if (closed || attempt.dead || attempt !== current) return
                attempt.lastMessageNanos = System.nanoTime()
                if (!attempt.ready && bytes.size > 96 * 1024) {
                    failAttemptLocked(attempt, "隧道响应无效")
                    return
                }
                val session = attempt.session ?: run {
                    failAttemptLocked(attempt, "隧道响应无效")
                    return
                }
                val frame = try {
                    session.open(bytes)
                } catch (error: RelayCryptoException) {
                    failAttemptLocked(attempt, error.message ?: "加密帧认证失败")
                    return
                }
                if (attempt.ready) {
                    dispatchFrameLocked(attempt, frame)
                } else {
                    if (attempt.inbox.size >= 32 ||
                        attempt.inboxBytes + bytes.size > 128 * 1024
                    ) {
                        failAttemptLocked(attempt, "桌面协议验证失败")
                        return
                    }
                    attempt.inbox.addLast(InboxItem(frame, bytes.size))
                    attempt.inboxBytes += bytes.size
                    attempt.inboxSignal.trySend(Unit)
                }
            }
        }

        override fun onClosed(reason: String) = failAttempt(attempt, reason)

        override fun onFailure(reason: String) = failAttempt(
            attempt,
            synchronized(monitor) {
                if (attempt.ready) reason else "无法连接中继，请检查网络和 HTTPS 域名"
            },
        )
    }

    private fun dispatchFrameLocked(attempt: Attempt, frame: JSONObject) {
        val kind = frame.opt("t") as? String
        if (kind != "hres" && kind != "hchunk" && kind != "hend" && kind != "herr") {
            failAttemptLocked(attempt, "未知的 Loopra 响应帧")
            return
        }
        val id = (frame.opt("id") as? String)?.takeIf { it.isNotEmpty() } ?: run {
            failAttemptLocked(attempt, "隧道请求标识无效")
            return
        }
        if (id == "__probe") {
            probeFrameLocked(attempt, frame, kind)
            return
        }
        val p = pending[id] ?: return
        if (p.attempt !== attempt) return
        if (p.error != null) return
        if (p.ended) {
            failAttemptLocked(attempt, "HTTP 响应已结束")
            return
        }
        var cancelId: String? = null
        when (kind) {
            "hres" -> {
                val status = optInt(frame, "status")
                if (status == null || status !in 200..599) {
                    failAttemptLocked(attempt, "HTTP 响应状态无效")
                    return
                }
                if (p.headReceived) {
                    failAttemptLocked(attempt, "HTTP 响应头重复")
                    return
                }
                if (frame.has("headers") && frame.optJSONObject("headers") == null) {
                    failAttemptLocked(attempt, "HTTP 响应头无效")
                    return
                }
                val headers = HashMap<String, String>()
                frame.optJSONObject("headers")?.let { obj ->
                    for (name in obj.keys()) {
                        val value = obj.opt(name)
                        if (value is String) headers[name] = value
                        else {
                            failAttemptLocked(attempt, "HTTP 响应头无效")
                            return
                        }
                    }
                }
                val invalid = headers.any { (name, value) ->
                    name.lowercase() !in RESPONSE_HEADERS ||
                        value.contains('\r') || value.contains('\n')
                }
                if (invalid) {
                    failAttemptLocked(attempt, "HTTP 响应头无效")
                    return
                }
                p.noBody = p.noBody || status == 204 || status == 205 || status == 304
                p.headReceived = true
                p.headers = headers
                p.head.complete(ResponseHead(status, headers))
            }
            "hchunk" -> {
                if (!p.headReceived) {
                    failAttemptLocked(attempt, "HTTP 响应顺序无效")
                    return
                }
                val b64 = frame.opt("b") as? String
                if (b64 == null || b64.length > B64_CHUNK_LIMIT) {
                    failAttemptLocked(attempt, "HTTP 响应分块过大")
                    return
                }
                val chunk = try {
                    RelayCodec.decode(b64)
                } catch (error: RelayCryptoException) {
                    failAttemptLocked(attempt, "HTTP 响应编码无效")
                    return
                }
                if (chunk.size > CHUNK_LIMIT) {
                    failAttemptLocked(attempt, "HTTP 响应分块过大")
                    return
                }
                p.total += chunk.size
                val sse = p.headers.any { (name, value) ->
                    name.equals("content-type", true) &&
                        value.split(';').firstOrNull()?.trim()
                            ?.equals("text/event-stream", true) == true
                }
                val limit = if (sse) SSE_LIMIT else BODY_LIMIT
                if (p.total > limit || bufferedBytes + chunk.size > BUFFER_LIMIT) {
                    p.error = "响应缓冲区或累计响应超过限制，请重试"
                    cancelId = id
                } else if (!p.noBody && chunk.isNotEmpty()) {
                    p.buffered += chunk.size
                    p.chunks.addLast(chunk)
                    bufferedBytes += chunk.size
                }
            }
            "hend" -> {
                if (!p.headReceived) {
                    failAttemptLocked(attempt, "HTTP 响应不完整")
                    return
                }
                p.ended = true
            }
            "herr" -> {
                p.error = ((frame.opt("message") as? String) ?: "桌面请求失败").take(1024)
            }
        }
        if (p.error != null) {
            bufferedBytes -= p.buffered
            p.chunks.clear()
            p.buffered = 0
            if (!p.head.isCompleted) {
                p.head.completeExceptionally(IllegalStateException(p.error))
            }
        }
        p.wake.trySend(Unit)
        if (cancelId != null) {
            p.cancellationSent = true
            sendFrame(attempt, JSONObject().put("t", "hcancel").put("id", cancelId))
        }
    }

    // ---- 帧收发与状态 ------------------------------------------------------------

    private fun sendText(attempt: Attempt, text: String): Boolean = synchronized(monitor) {
        if (closed || attempt.dead || attempt !== current) return@synchronized false
        attempt.socket?.sendText(text) == true
    }

    private fun sendFrame(attempt: Attempt, frame: JSONObject): Boolean = synchronized(monitor) {
        if (closed || attempt.dead || attempt !== current) return@synchronized false
        val session = attempt.session ?: return@synchronized false
        val socket = attempt.socket ?: return@synchronized false
        val wire = try {
            session.seal(frame)
        } catch (error: Exception) {
            failAttemptLocked(attempt, error.message ?: "请求加密失败")
            return@synchronized false
        }
        if (!socket.sendBinary(wire)) {
            failAttemptLocked(attempt, "中继发送失败")
            return@synchronized false
        }
        true
    }

    private fun failAttempt(attempt: Attempt, error: String) = synchronized(monitor) {
        failAttemptLocked(attempt, error)
    }

    private fun failAttemptLocked(attempt: Attempt, error: String) {
        if (attempt.dead || attempt !== current) return
        attempt.dead = true
        attempt.failureReason = error
        attempt.probe?.timer?.cancel()
        runCatching { attempt.socket?.cancel() }
        attempt.failure.complete(error)
    }

    private fun readStep(requestId: String, entry: Pending): ReadStep = synchronized(monitor) {
        entry.error?.let {
            removePendingLocked(requestId, entry)
            return@synchronized ReadStep.Fail(it)
        }
        val chunk = entry.chunks.removeFirstOrNull()
        if (chunk != null) {
            entry.buffered -= chunk.size
            bufferedBytes -= chunk.size
            return@synchronized ReadStep.Data(chunk)
        }
        if (entry.ended) {
            removePendingLocked(requestId, entry)
            return@synchronized ReadStep.Eof
        }
        ReadStep.WaitFor(entry.wake)
    }

    private fun cancelRequest(requestId: String, expected: Pending) {
        val attempt = synchronized(monitor) { cancelRequestLocked(requestId, expected) }
        attempt?.let {
            sendFrame(it, JSONObject().put("t", "hcancel").put("id", requestId))
        }
    }

    /** 原子移除 pending 并按需返回应发送 hcancel 的 attempt；重复取消去重。 */
    private fun cancelRequestLocked(requestId: String, expected: Pending?): Attempt? {
        val p = pending[requestId] ?: return null
        if (expected != null && p !== expected) return null
        val sendCancel = !p.cancellationSent
        p.cancellationSent = true
        if (sendCancel) {
            cancelled.addLast(requestId)
            while (cancelled.size > 256) cancelled.removeFirst()
        }
        removePendingLocked(requestId)
        return if (sendCancel && !closed && p.attempt === current && !p.attempt.dead) {
            p.attempt
        } else {
            null
        }
    }

    private fun removePendingLocked(id: String, expected: Pending? = null): Pending? {
        val p = pending[id] ?: return null
        if (expected != null && p !== expected) return null
        pending.remove(id)
        bufferedBytes -= p.buffered
        if (!p.head.isCompleted) {
            p.head.completeExceptionally(IllegalStateException(p.error ?: "请求已取消"))
        }
        p.wake.trySend(Unit)
        return p
    }

    private fun failPendingLocked(error: String) {
        connected = false
        bufferedBytes = 0
        for (p in pending.values) {
            p.chunks.clear()
            p.buffered = 0
            p.error = error
            if (!p.head.isCompleted) {
                p.head.completeExceptionally(IllegalStateException(error))
            }
            p.wake.trySend(Unit)
        }
    }

    private fun publish(state: String, error: String?) {
        synchronized(monitor) {
            if (!closed) publishLocked(state, error)
        }
    }

    private fun publishLocked(state: String, error: String?) {
        statusFlow.value = RelayStatus(state, error, statusFlow.value.revision + 1)
        healthSignal.complete(Unit)
        healthSignal = CompletableDeferred()
    }

    private fun isClosed(): Boolean = synchronized(monitor) { closed }

    private fun isFatal(error: String): Boolean =
        error.contains("身份验证失败") ||
            error.contains("协议不兼容") ||
            error.contains("桌面尚未支持")

    /** org.json 会把数字存成 Int/Long/Double；与 Rust as_u64 对齐，只接受整数。 */
    private fun optInt(frame: JSONObject?, key: String): Int? = when (val value = frame?.opt(key)) {
        is Int -> value
        is Long ->
            if (value >= Int.MIN_VALUE.toLong() && value <= Int.MAX_VALUE.toLong()) {
                value.toInt()
            } else {
                null
            }
        else -> null
    }

    // ---- 内部状态 ---------------------------------------------------------------

    private data class InboxItem(val message: Any, val bytes: Int)

    private inner class Attempt {
        var socket: RelaySocket? = null
        var session: RelayCipher? = null
        var ready = false
        var dead = false
        var probe: Probe? = null
        var lastMessageNanos = System.nanoTime()
        var failureReason: String? = null
        val failure = CompletableDeferred<String>()
        val inbox = ArrayDeque<InboxItem>()
        var inboxBytes = 0
        val inboxSignal = Channel<Unit>(Channel.CONFLATED)

        suspend fun awaitInbox(): Any {
            while (true) {
                val item = synchronized(monitor) {
                    if (dead) {
                        throw TunnelException(
                            failureReason ?: "中继已断开，正在重新连接",
                        )
                    }
                    inbox.removeFirstOrNull()
                        ?.also { inboxBytes -= it.bytes }
                        ?.message
                }
                if (item != null) return item
                select<Unit> {
                    failure.onAwait { throw TunnelException(it) }
                    inboxSignal.onReceive { }
                }
            }
        }
    }

    private inner class Probe {
        var timer: kotlinx.coroutines.Job? = null
        var headers = false
        var received = 0
    }

    private inner class Pending(val attempt: Attempt, val method: String) {
        val head = CompletableDeferred<ResponseHead>()
        val wake = Channel<Unit>(Channel.CONFLATED)
        val chunks = ArrayDeque<ByteArray>()
        var headReceived = false
        var headers = emptyMap<String, String>()
        var buffered = 0
        var total = 0
        var ended = false
        var error: String? = null
        var noBody = method == "HEAD"
        var cancellationSent = false
    }

    private sealed interface ReadStep {
        class Data(val bytes: ByteArray) : ReadStep
        class WaitFor(val wake: Channel<Unit>) : ReadStep
        class Fail(val message: String) : ReadStep
        object Eof : ReadStep
    }

    private fun validate(request: RelayRequest) {
        if (request.id.isEmpty() || request.id.length > 128 || request.id.startsWith("__") ||
            !request.path.startsWith("/api/") ||
            request.path.any { it == '\\' || it == '\r' || it == '\n' || it == '#' } ||
            request.path.length > 8192 ||
            request.body.size > 6 shl 20 ||
            request.method !in METHODS
        ) {
            throw IllegalArgumentException("无效的 Loopra API 请求")
        }
        if (request.headers.size > 4 || request.headers.any { (name, value) ->
                name !in REQUEST_HEADERS || value.length > 8192 ||
                    value.contains('\r') || value.contains('\n')
            }
        ) {
            throw IllegalArgumentException("无效的 Loopra 请求头")
        }
        // 先规范化点分段再校验桌面 API 边界（与 Rust url::Url::parse 行为一致）。
        val target = "https://loopra.invalid/".toHttpUrl().resolve(request.path)
            ?: throw IllegalArgumentException("无效的 Loopra API 路径")
        if (!target.encodedPath.startsWith("/api/")) {
            throw IllegalArgumentException("无效的 Loopra API 路径")
        }
    }

    companion object {
        private const val BUFFER_LIMIT = 8 shl 20
        private const val CHUNK_LIMIT = 64 shl 10
        /** base64 形态下单块 64KiB 上限：ceil(65536/3)*4。 */
        private const val B64_CHUNK_LIMIT = 87_384
        private const val BODY_LIMIT = 16 shl 20
        private const val SSE_LIMIT = 256 shl 20

        private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
        private val REQUEST_HEADERS = setOf("content-type", "accept", "x-request-id", "range")
        private val RESPONSE_HEADERS = setOf(
            "content-type", "content-length", "content-disposition", "content-encoding",
            "cache-control", "etag", "last-modified", "accept-ranges", "content-range",
            "location", "allow", "expires", "vary",
        )
    }
}

package app.loopra.android.data

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import org.json.JSONObject

/** SSE 帧解析错误（帧过大或流终止状态非法）。 */
class SseException(message: String) : Exception(message)

/** 跨块增量 UTF-8 解码：中文等多字节字符可能被网络块切开。 */
class Utf8StreamDecoder {
    private val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)
    private val out = CharBuffer.allocate(8192)
    // UNDERFLOW 后 input 里仍残留的半个多字节字符（UTF-8 最多 3 字节），
    // 必须带到下一块一起解码，否则会产生替换字符。
    private var pending = ByteArray(0)

    fun decode(bytes: ByteArray, end: Boolean = false): String {
        val input = ByteBuffer.wrap(if (pending.isEmpty()) bytes else pending + bytes)
        pending = ByteArray(0)
        val result = StringBuilder()
        while (true) {
            out.clear()
            val status = decoder.decode(input, out, end)
            out.flip()
            result.append(out)
            if (status.isUnderflow) break
            if (status.isOverflow) continue
            if (status.isError) continue // REPLACE 已配置：跳过畸形字节继续
        }
        if (!end && input.hasRemaining()) {
            pending = ByteArray(input.remaining())
            input.get(pending)
        }
        if (end) {
            out.clear()
            decoder.flush(out)
            out.flip()
            result.append(out)
        }
        return result.toString()
    }
}

/**
 * `web/src/backend.ts` SseParser 的 Kotlin 移植：\n 切行去 \r，event 行定
 * 类型，data 行按 \n 连接，空行结束一帧；[DONE] 视为 done；无 event 名默认
 * content；data 先 JSON.parse，对象并入事件，字符串进入 content。
 */
class SseParser(private val emit: (StreamEvent) -> Unit) {
    private val buffer = StringBuilder()
    private var type = ""
    private val data = mutableListOf<String>()
    private var dataSize = 0

    fun push(chunk: String, end: Boolean = false) {
        buffer.append(chunk)
        var index: Int
        while (buffer.indexOf('\n').also { index = it } >= 0) {
            line(buffer.substring(0, index).removeSuffix("\r"))
            buffer.delete(0, index + 1)
        }
        if (buffer.length > MAX_FRAME_CHARS + 8192) {
            throw SseException("SSE 帧超过大小限制")
        }
        if (end) {
            if (buffer.isNotEmpty()) line(buffer.toString().removeSuffix("\r"))
            buffer.clear()
            line("")
        }
    }

    private fun line(line: String) {
        if (line.isEmpty()) {
            if (data.isNotEmpty()) {
                val raw = data.joinToString("\n")
                if (raw.length > MAX_FRAME_CHARS) throw SseException("SSE 帧超过大小限制")
                emit(parseFrame(raw))
            }
            type = ""
            data.clear()
            dataSize = 0
            return
        }
        if (line.startsWith(":")) return
        val colon = line.indexOf(':')
        val key = if (colon < 0) line else line.substring(0, colon)
        val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
        when (key) {
            "event" -> type = value
            "data" -> {
                data.add(value)
                dataSize += value.length
                if (dataSize > MAX_FRAME_CHARS) throw SseException("SSE 帧超过大小限制")
            }
        }
    }

    private fun parseFrame(raw: String): StreamEvent {
        if (raw == "[DONE]") return StreamEvent("done")
        val eventType = type.ifEmpty { "content" }
        // 与 JSON.parse 语义一致：整段必须是合法 JSON；否则按原始字符串处理。
        val trimmed = raw.trim()
        val parsed: Any? = when {
            trimmed.startsWith("{") ->
                runCatching { JSONObject(trimmed) }.getOrNull()
            trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"") ->
                runCatching { org.json.JSONTokener(trimmed).nextValue() as? String }.getOrNull()
            else -> null
        }
        // 已知的结构化事件必须携带 JSON 对象；畸形数据不能静默当作
        // complete/done 终点或普通文本通过，否则会造成错误的回合判定。
        if (parsed !is JSONObject && eventType in STRUCTURED_TYPES) {
            throw SseException("SSE 事件 $eventType 携带非法数据")
        }
        return when (parsed) {
            is JSONObject -> StreamEvent(eventType, parsed)
            is String -> StreamEvent.text(eventType, parsed)
            else -> StreamEvent.text(eventType, raw)
        }
    }

    companion object {
        const val MAX_FRAME_CHARS = 1 shl 20

        // 已知结构化事件：data 必须是 JSON 对象，不能退化成裸文本。
        private val STRUCTURED_TYPES = setOf(
            "reasoning_started", "tool_call", "tool_update", "tool_result",
            "complete", "stream_reset", "error", "done", "choice", "permission_resolved",
            "file_changes", "elicitation", "sub_start", "sub_content",
            "sub_reasoning", "sub_tool_call", "sub_tool_result", "sub_end",
            "sub_choice", "sub_complete", "sub_error", "title", "turn_state",
            "session_title", "queue", "native_reply_stopped",
        )
    }
}

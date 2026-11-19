package app.loopra.android

import app.loopra.android.data.LoopraRepository
import app.loopra.android.data.Pairing
import app.loopra.android.data.RelayConnection
import app.loopra.android.data.RelayRequest
import app.loopra.android.data.RelayStatus
import app.loopra.android.data.ResponseHead
import app.loopra.android.data.StreamEvent
import app.loopra.android.data.StreamFailedException
import app.loopra.android.data.StreamInterruptedException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/** chatStream 的流解析/背压/终止语义，用假隧道连接验证。 */
class RepositoryStreamTest {

    private class FakeConnection(
        private val headStatus: Int = 200,
        private val chunks: List<String> = emptyList(),
    ) : RelayConnection {
        override val pairing = Pairing("https://relay.example.com", "A".repeat(43))
        val cancelled = mutableListOf<String>()
        var cancelCalls = 0

        override fun statusNow() = RelayStatus("connected", null, 1)
        override suspend fun check() {}
        override suspend fun send(request: RelayRequest): ResponseHead =
            ResponseHead(headStatus, mapOf("content-type" to "text/event-stream"))
        override fun readBody(requestId: String): Flow<ByteArray> = flow {
            for (chunk in chunks) emit(chunk.toByteArray(Charsets.UTF_8))
        }
        override fun cancel(requestId: String) {
            cancelCalls++
            cancelled.add(requestId)
        }
        override fun close() {}
    }

    private fun repo(conn: FakeConnection) = LoopraRepository(conn)

    private fun body() = JSONObject()
        .put("message", "hi")
        .put("requestId", "r1")
        .put("workspaceHash", "w")
        .put("sessionName", "s")

    @Test
    fun moreThan64EventsInOneChunkAllEmittedInOrder() = runBlocking {
        val frames = buildString {
            repeat(120) { i ->
                append("event: content\ndata: \"t$i\"\n\n")
            }
            append("data: [DONE]\n\n")
        }
        val conn = FakeConnection(chunks = listOf(frames))
        val events = repo(conn).chatStream(body(), "r1").toList()
        assertEquals(121, events.size)
        repeat(120) { i ->
            assertEquals("content", events[i].type)
            assertEquals("t$i", events[i].content)
        }
        assertEquals("done", events[120].type)
        assertEquals(1, conn.cancelCalls)
    }

    @Test
    fun errorEventThrowsStreamFailedException() = runBlocking {
        val conn = FakeConnection(
            chunks = listOf("data: \"前缀\"\n\nevent: error\ndata: {\"error\":\"模型失败\",\"reason\":\"quota\"}\n\n"),
        )
        val collected = mutableListOf<StreamEvent>()
        try {
            repo(conn).chatStream(body(), "r1").collect { collected.add(it) }
            fail("expected StreamFailedException")
        } catch (error: StreamFailedException) {
            assertEquals("模型失败", error.message)
            assertEquals("quota", error.reason)
        }
        assertEquals(listOf("content", "error"), collected.map { it.type })
        assertEquals(1, conn.cancelCalls)
    }

    @Test
    fun doneStopsReadingTrailingChunks() = runBlocking {
        val conn = FakeConnection(
            chunks = listOf(
                "data: \"a\"\n\ndata: [DONE]\n\n",
                "data: \"不应到达\"\n\n",
            ),
        )
        val events = repo(conn).chatStream(body(), "r1").toList()
        assertEquals(listOf("content", "done"), events.map { it.type })
    }

    @Test
    fun unexpectedEofThrowsInterrupted() = runBlocking {
        val conn = FakeConnection(chunks = listOf("data: \"半截\"\n\n"))
        try {
            repo(conn).chatStream(body(), "r1").toList()
            fail("expected StreamInterruptedException")
        } catch (expected: StreamInterruptedException) {
        }
    }

    @Test
    fun httpRejectThrowsApiException() = runBlocking {
        val conn = FakeConnection(
            headStatus = 409,
            chunks = listOf("{\"success\":false,\"error\":\"会话忙\",\"reason\":\"thread_active_writer\"}"),
        )
        try {
            repo(conn).chatStream(body(), "r1").toList()
            fail("expected ApiException")
        } catch (error: app.loopra.android.data.ApiException) {
            assertEquals("会话忙", error.message)
            assertEquals("thread_active_writer", error.reason)
        }
        assertEquals(1, conn.cancelCalls)
    }

    @Test
    fun multibyteSplitAcrossReads() = runBlocking {
        val frame = "event: content\ndata: \"中文回复\"\n\ndata: [DONE]\n\n"
        val bytes = frame.toByteArray(Charsets.UTF_8)
        val conn = FakeConnection()
        // 在多字节字符内部把字节流切开：增量解码必须无损拼接。
        val split1 = bytes.size / 3
        val split2 = bytes.size * 2 / 3
        val byteConn = object : RelayConnection by conn {
            override fun readBody(requestId: String): Flow<ByteArray> = flow {
                emit(bytes.copyOfRange(0, split1))
                emit(bytes.copyOfRange(split1, split2))
                emit(bytes.copyOfRange(split2, bytes.size))
            }
        }
        val events = LoopraRepository(byteConn).chatStream(body(), "r1").toList()
        assertEquals("中文回复", events[0].content)
        assertEquals("done", events[1].type)
    }
}

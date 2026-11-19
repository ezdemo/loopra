package app.loopra.android

import app.loopra.android.data.Pairing
import app.loopra.android.data.RelayClient
import app.loopra.android.data.RelayCodec
import app.loopra.android.data.RelayRequest
import app.loopra.android.data.RelayTiming
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RelayClientTest {

    private val pairing = Pairing("https://relay.example.com", "A".repeat(43))

    private fun timing() = RelayTiming(
        establishMs = 5_000,
        probeTimeoutMs = 400,
        probeIntervalMs = 100,
        livenessMs = 2_000,
        responseHeadMs = 2_000,
        checkMs = 1_500,
        backoffMs = longArrayOf(20, 40, 80),
    )

    private fun client(relay: ScriptedRelay): RelayClient =
        RelayClient(pairing, socketFactory = relay, timing = timing())

    private suspend fun awaitState(client: RelayClient, state: String, timeoutMs: Long = 5_000) {
        withTimeout(timeoutMs) {
            while (client.statusNow().state != state) delay(10)
        }
    }

    @Test
    fun requestBodyAndEchoRoundTrip() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            if (frame.optString("path") == "/api/echo") {
                socket.finish(
                    frame.optString("id"),
                    RelayCodec.decode(frame.optString("b", "")),
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        val head = client.send(RelayRequest("r1", "/api/echo", "POST", body = byteArrayOf(9, 8, 7)))
        assertEquals(200, head.status)
        val body = client.readBody("r1").toList().fold(ByteArray(0)) { acc, b -> acc + b }
        assertArrayEquals(byteArrayOf(9, 8, 7), body)
        client.close()
    }

    @Test
    fun preArrivedBodyStillDeliveredToLateCollector() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            when (frame.optString("path")) {
                "/api/full" -> socket.finish(
                    frame.optString("id"),
                    "完整响应体".toByteArray(),
                    "application/json",
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        client.send(RelayRequest("r1", "/api/full"))
        // hres+hchunk+hend 都在收集器启动前到达，body 不能丢。
        delay(100)
        val bytes = client.readBody("r1").toList().fold(ByteArray(0)) { acc, b -> acc + b }
        assertEquals("完整响应体", String(bytes))
        client.close()
    }

    @Test
    fun cancellingReadReleasesPendingImmediately() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            when (frame.optString("path")) {
                "/api/wait" -> socket.deliverFrame(
                    JSONObject().put("t", "hres").put("id", frame.optString("id"))
                        .put("status", 200)
                        .put("headers", JSONObject().put("content-type", "text/event-stream")),
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        val socket = relay.sockets.last()
        client.send(RelayRequest("w1", "/api/wait"))
        val job = async(Dispatchers.IO) { client.readBody("w1").first() }
        delay(100) // 让收集器进入等待
        job.cancelAndJoin()
        // hcancel 到达对端 pending：取消必须立刻释放隧道内请求。
        withTimeout(5_000) {
            while (socket.receivedFrames.none {
                    it.optString("t") == "hcancel" && it.optString("id") == "w1"
                }
            ) {
                delay(10)
            }
        }
        client.close()
    }

    @Test
    fun closeFailsPendingReads() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            when (frame.optString("path")) {
                "/api/wait" -> socket.deliverFrame(
                    JSONObject().put("t", "hres").put("id", frame.optString("id"))
                        .put("status", 200),
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        client.send(RelayRequest("w2", "/api/wait"))
        val collected = mutableListOf<ByteArray>()
        val job = async(Dispatchers.IO) {
            try {
                client.readBody("w2").collect { collected.add(it) }
                null
            } catch (error: Exception) {
                error
            }
        }
        delay(100)
        client.close()
        val error = withTimeout(5_000) { job.await() }
        assertTrue(collected.isEmpty())
        assertTrue(error != null)
        assertEquals("closed", client.statusNow().state)
    }

    @Test
    fun herrFailsOnlyThatStream() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            when (frame.optString("path")) {
                "/api/ok" -> socket.finish(frame.optString("id"), "ok".toByteArray())
                "/api/err" -> socket.deliverFrame(
                    JSONObject().put("t", "herr").put("id", frame.optString("id"))
                        .put("message", "桌面请求失败"),
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        val err = async {
            try {
                client.send(RelayRequest("e1", "/api/err"))
                null
            } catch (error: Exception) {
                error
            }
        }
        val ok = client.send(RelayRequest("o1", "/api/ok"))
        assertEquals(200, ok.status)
        assertEquals("ok", client.readBody("o1").toList().joinToString("") { String(it) })
        val error = err.await()
        assertTrue(error != null && error.message!!.contains("桌面请求失败"))
        assertEquals("connected", client.statusNow().state)
        client.close()
    }

    @Test
    fun dropFailsPendingAndReconnects() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        val client = client(relay)
        awaitState(client, "connected")
        relay.sockets.first().fail()
        awaitState(client, "disconnected")
        // 不跨重连排队写入：旧请求失败，新握手在新 socket 上完成。
        awaitState(client, "connected")
        assertTrue(relay.sockets.size >= 2)
        client.close()
    }

    @Test
    fun invalidAuthenticationIsTerminal() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.corruptConfirm = true
        val client = client(relay)
        awaitState(client, "closed", 10_000)
        assertTrue(client.statusNow().error!!.contains("身份验证失败"))
        // 终态连接上 check() 必须立即失败，不能等超时或继续重连。
        try {
            withTimeout(1_000) { client.check() }
            fail("closed 连接上的 check 应立即失败")
        } catch (expected: IllegalStateException) {
            assertEquals("连接已关闭", expected.message)
        }
        client.close()
    }

    @Test
    fun closeDuringHandshakeIsClean() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.answerText = null // 收到 hello 但永远不回
        val client = client(relay)
        delay(150)
        client.close()
        assertEquals("closed", client.statusNow().state)
        // close 后再发请求必须立即失败而不是挂起。
        try {
            client.send(RelayRequest("x", "/api/x"))
            fail("closed 后 send 应立即失败")
        } catch (expected: IllegalStateException) {
            assertEquals("连接已关闭", expected.message)
        }
    }

    @Test
    fun herrDoesNotLeakPendingSlots() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            when (frame.optString("path")) {
                "/api/err" -> socket.deliverFrame(
                    JSONObject().put("t", "herr").put("id", frame.optString("id"))
                        .put("message", "桌面请求失败"),
                )
                "/api/ok" -> socket.finish(frame.optString("id"), "ok".toByteArray())
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        // 超过 63 个隧道名额的失败请求都不能占住 pending。
        repeat(70) { i ->
            try {
                client.send(RelayRequest("e$i", "/api/err"))
                fail("herr 应使 send 失败")
            } catch (expected: IllegalStateException) {
                assertTrue(expected.message!!.contains("桌面请求失败"))
            }
        }
        val head = client.send(RelayRequest("last", "/api/ok"))
        assertEquals(200, head.status)
        assertEquals("ok", client.readBody("last").toList().joinToString("") { String(it) })
        client.close()
    }

    @Test
    fun malformedResponseOrderBreaksTunnel() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            if (frame.optString("path") == "/api/bad") {
                // hchunk 先于 hres：协议错误必须断开隧道而不是吞掉。
                socket.deliverFrame(
                    JSONObject().put("t", "hchunk").put("id", frame.optString("id"))
                        .put("b", RelayCodec.encode("x".toByteArray())),
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        val revision = client.statusNow().revision
        try {
            client.send(RelayRequest("b1", "/api/bad"))
            fail("乱序响应应使请求失败")
        } catch (expected: IllegalStateException) {
        }
        // 不可恢复的帧错误 → 断开 → 自动重连。
        withTimeout(10_000) {
            while (!(client.statusNow().state == "connected" &&
                    client.statusNow().revision > revision)
            ) {
                delay(20)
            }
        }
        assertTrue(relay.sockets.size >= 2)
        client.close()
    }

    @Test
    fun inFlightPendingFailsOnDrop() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.onFrame = { socket, frame ->
            when (frame.optString("path")) {
                "/api/hang" -> socket.fail() // 响应途中断链
                "/api/echo" -> socket.finish(
                    frame.optString("id"),
                    RelayCodec.decode(frame.optString("b", "")),
                )
            }
        }
        val client = client(relay)
        awaitState(client, "connected")
        val revision = client.statusNow().revision
        try {
            client.send(RelayRequest("h1", "/api/hang"))
            fail("断链应使在途请求失败")
        } catch (expected: IllegalStateException) {
        }
        // 老 pending 释放，不跨重连排队写入。
        withTimeout(10_000) {
            while (!(client.statusNow().state == "connected" &&
                    client.statusNow().revision > revision)
            ) {
                delay(20)
            }
        }
        client.send(RelayRequest("h2", "/api/echo", "POST", body = byteArrayOf(7)))
        assertEquals(7, client.readBody("h2").toList().first().first().toInt())
        client.close()
    }

    @Test
    fun stallHandshakeDoesNotMarkConnected() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        relay.answerText = null // 收 hello 但不回应
        val client = RelayClient(
            pairing, socketFactory = relay,
            timing = timing().let {
                RelayTiming(
                    establishMs = 300, probeTimeoutMs = it.probeTimeoutMs,
                    probeIntervalMs = it.probeIntervalMs, livenessMs = it.livenessMs,
                    responseHeadMs = it.responseHeadMs, checkMs = it.checkMs,
                    backoffMs = it.backoffMs,
                )
            },
        )
        delay(900)
        assertTrue(client.statusNow().state != "connected")
        client.close()
    }

    @Test
    fun sendRejectsInvalidRequest() = runBlocking {
        val relay = ScriptedRelay(pairing.connectCode)
        val client = client(relay)
        awaitState(client, "connected")
        for (request in listOf(
            RelayRequest("", "/api/x"),
            RelayRequest("a".repeat(129), "/api/x"),
            RelayRequest("__probe", "/api/x"),
            RelayRequest("x", "/other/x"),
            RelayRequest("x", "/api/../x"),
            RelayRequest("x", "/api/%2e%2e/x"),
            RelayRequest("x", "/api/x", "BREW"),
            RelayRequest("x", "/api/x", "POST", body = ByteArray((6 shl 20) + 1)),
            RelayRequest("x", "/api/x", "GET", mapOf("x-evil" to "v")),
        )) {
            try {
                client.send(request)
                fail("应拒绝请求 $request")
            } catch (expected: IllegalArgumentException) {
            }
        }
        client.close()
    }
}

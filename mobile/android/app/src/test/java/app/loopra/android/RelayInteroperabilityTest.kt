package app.loopra.android

import app.loopra.android.data.OkHttpSocketFactory
import app.loopra.android.data.Pairing
import app.loopra.android.data.RelayClient
import app.loopra.android.data.RelayRequest
import app.loopra.android.data.RelayTiming
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume
import org.junit.Before
import org.junit.Test

/**
 * 与 `mobile/tests/native-relay-peer.mjs`（独立 Node WebCrypto + ws 实现）的
 * 端到端加密互通测试。fixture 首行 stdout 输出回环 relay 地址，代码固定为
 * 0x07*32；所有模式下的子进程都在 finally 中销毁。
 *
 * 需要显式打开：`LOOPRA_ANDROID_INTEROP=1 ./gradlew.bat :app:testDebugUnitTest`
 * （依赖本机 Node 与 mobile/node_modules 的 ws，默认跳过）。
 * `LOOPRA_NATIVE_DESKTOP_FIXTURE` 指向预构建的 native-relay-desktop 二进制时，
 * 额外执行桌面模式（真实 Go 对端经 fixture 中继代理）。
 */
class RelayInteroperabilityTest {

    private val code = java.util.Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(32) { 7 })

    @Before
    fun requireInteropEnv() {
        Assume.assumeTrue(
            "需要 LOOPRA_ANDROID_INTEROP=1 运行真实 Node 互通测试",
            System.getenv("LOOPRA_ANDROID_INTEROP") == "1",
        )
    }

    private fun fixturePath(): File {
        // Gradle 测试工作目录为 app/；向上查找仓库根。
        var dir = File(System.getProperty("user.dir") ?: ".").canonicalFile
        repeat(6) {
            val candidate = File(dir, "mobile/tests/native-relay-peer.mjs")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: return@repeat
        }
        error("找不到 mobile/tests/native-relay-peer.mjs")
    }

    private class Fixture(val process: Process, val url: String)

    private fun spawnFixture(mode: String): Fixture {
        val fixture = fixturePath()
        val process = ProcessBuilder("node", fixture.absolutePath, "0", mode)
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .directory(fixture.parentFile)
            .start()
        try {
            val url = CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().use { it.readLine() }
            }.get(10, TimeUnit.SECONDS) ?: error("fixture 未输出地址")
            return Fixture(process, url.trim())
        } catch (error: Exception) {
            process.destroyForcibly()
            process.waitFor(5, TimeUnit.SECONDS)
            throw error
        }
    }

    private fun timing() = RelayTiming(
        establishMs = 10_000,
        probeTimeoutMs = 2_000,
        probeIntervalMs = 400,
        livenessMs = 4_000,
        responseHeadMs = 8_000,
        checkMs = 5_000,
        backoffMs = longArrayOf(50, 100, 200),
    )

    private fun client(url: String): RelayClient = RelayClient(
        Pairing(url, code),
        socketFactory = OkHttpSocketFactory(OkHttpClient()),
        timing = timing(),
    )

    private suspend fun awaitState(client: RelayClient, state: String, timeoutMs: Long = 15_000) {
        withTimeout(timeoutMs) {
            while (client.statusNow().state != state) delay(25)
        }
    }

    /** 等待一次新的 connected 转换（revision 递增），不依赖可见的 disconnected 窗口。 */
    private suspend fun awaitReconnect(client: RelayClient, before: Long, timeoutMs: Long = 20_000) {
        withTimeout(timeoutMs) {
            while (!(client.statusNow().state == "connected" &&
                    client.statusNow().revision > before)
            ) {
                delay(25)
            }
        }
    }

    private suspend fun body(client: RelayClient, id: String): String =
        client.readBody(id).toList().joinToString("") { String(it) }

    @Test
    fun normalModeFullLifecycle() = runBlocking {
        val fixture = spawnFixture("")
        val client = client(fixture.url)
        try {
            awaitState(client, "connected")

            // 并发回显（含中文）与 SSE。
            val echo = async {
                client.send(
                    RelayRequest("echo-1", "/api/echo", "POST",
                        body = "你好 Loopra".toByteArray()),
                )
                body(client, "echo-1")
            }
            val sse = async {
                client.send(RelayRequest("sse-1", "/api/sse"))
                body(client, "sse-1")
            }
            assertEquals("你好 Loopra", echo.await())
            assertTrue(sse.await().contains("你好"))

            // /api/wait：取消隧道流 → 对端记录 hcancel → /api/cancelled/{id} 为 true。
            client.send(RelayRequest("w1", "/api/wait"))
            client.cancel("w1")
            delay(200)
            client.send(RelayRequest("c1", "/api/cancelled/w1"))
            assertEquals("true", body(client, "c1"))

            client.check()
            assertEquals("connected", client.statusNow().state)
        } finally {
            client.close()
            fixture.process.destroyForcibly()
            fixture.process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun headEmptyModeProbesStayConnected() = runBlocking {
        val fixture = spawnFixture("head-empty")
        val client = client(fixture.url)
        try {
            awaitState(client, "connected")
            repeat(3) { client.check() }
            delay(1_000) // 让周期探测也跑过几轮
            assertEquals("connected", client.statusNow().state)
        } finally {
            client.close()
            fixture.process.destroyForcibly()
            fixture.process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun staleModeReconnectsAfterUnansweredProbe() = runBlocking {
        val fixture = spawnFixture("stale")
        val client = client(fixture.url)
        try {
            awaitState(client, "connected")
            // 连接 1 不回应探测 → 探测超时 → 断开 → 连接 2 正常应答。
            awaitReconnect(client, client.statusNow().revision)
            client.send(RelayRequest("r2", "/api/echo", "POST", body = byteArrayOf(1, 2, 3)))
            assertEquals(3, body(client, "r2").toByteArray(Charsets.UTF_8).size)
        } finally {
            client.close()
            fixture.process.destroyForcibly()
            fixture.process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun dropFailsPendingAndDoesNotReplay() = runBlocking {
        val fixture = spawnFixture("")
        val client = client(fixture.url)
        try {
            awaitState(client, "connected")
            val revision = client.statusNow().revision
            try {
                client.send(RelayRequest("d1", "/api/drop"))
                fail("/api/drop 应因连接断开而失败")
            } catch (expected: IllegalStateException) {
                assertTrue(expected.message!!.isNotEmpty())
            }
            awaitReconnect(client, revision)
            client.send(RelayRequest("d2", "/api/echo", "POST", body = "恢复".toByteArray()))
            assertEquals("恢复", body(client, "d2"))
            // 旧请求不重放：fixture 只收到一次 /api/drop；复用 d1 会被请求契约拒绝。
            try {
                client.send(RelayRequest("d1", "/api/echo"))
                fail("断开期间失败的请求标识不应静默重用")
            } catch (expected: IllegalStateException) {
            }
        } finally {
            client.close()
            fixture.process.destroyForcibly()
            fixture.process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun stallModeNeverMarksConnected() = runBlocking {
        val fixture = spawnFixture("stall")
        val client = client(fixture.url)
        try {
            delay(2_000) // 建连超时 10s 内的窗口：始终未握手
            assertTrue(client.statusNow().state != "connected")
        } finally {
            client.close()
            fixture.process.destroyForcibly()
            fixture.process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun desktopModeRealPeerHandshake() = runBlocking {
        val binary = System.getenv("LOOPRA_NATIVE_DESKTOP_FIXTURE")
        Assume.assumeTrue(
            "需要 LOOPRA_NATIVE_DESKTOP_FIXTURE 指向预构建桌面 fixture 二进制",
            !binary.isNullOrBlank(),
        )
        // fixture 以 desktop 模式运行：Node 只做中继转发，握手与隧道帧来自真实 Go 对端。
        val fixture = spawnFixture("desktop")
        val client = client(fixture.url)
        try {
            awaitState(client, "connected", 30_000)
            val revision = client.statusNow().revision
            repeat(3) { client.check() }
            delay(1_200) // 两轮探测间隔后健康检查不制造状态抖动
            assertEquals("connected", client.statusNow().state)
            assertEquals(revision, client.statusNow().revision)

            client.send(RelayRequest("hs-1", "/api/mobile/handshake"))
            val data = JSONObject(body(client, "hs-1"))
            assertTrue(data.optBoolean("success"))
            assertEquals("loopra-relay", data.optJSONObject("data")?.optString("protocol"))
        } finally {
            client.close()
            fixture.process.destroyForcibly()
            fixture.process.waitFor(5, TimeUnit.SECONDS)
        }
    }
}

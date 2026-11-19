package app.loopra.android

import app.loopra.android.data.RelayCipher
import app.loopra.android.data.RelayCodec
import app.loopra.android.data.RelaySocket
import app.loopra.android.data.RelaySocketFactory
import app.loopra.android.data.RelaySocketListener
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.KeyAgreement
import org.json.JSONObject

/**
 * 与 `mobile/tests/native-relay-peer.mjs` 等价的应答方握手实现，
 * 供 JVM 假链路测试使用；真实互通性由 Node fixture 测试独立覆盖。
 */
internal class PeerHandshake(private val code: String) {
    private val random = SecureRandom()
    private var clientHello: JSONObject? = null
    private var peerHello: JSONObject? = null
    private var cipher: RelayCipher? = null
    private var expectedCi: String? = null
    var confirmOverride: String? = null

    fun acceptHello(hello: JSONObject): PeerHandshake {
        clientHello = hello
        val epk = RelayCodec.decode(hello.optString("epk", ""))
        val clientNonce = RelayCodec.decode(hello.optString("n", ""))
        require(hello.optString("t") == "hi" && epk.size == 65 &&
            epk[0].toInt() == 4 && clientNonce.size == 16) { "bad hello" }
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"), random)
        val pair = generator.generateKeyPair()
        val ecPublic = pair.public as ECPublicKey
        val x = unsigned(ecPublic.w.affineX)
        val y = unsigned(ecPublic.w.affineY)
        val publicRaw = byteArrayOf(4) + x + y
        nonce = ByteArray(16).also(random::nextBytes)
        val client = KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(
                ECPoint(
                    BigInteger(1, epk.copyOfRange(1, 33)),
                    BigInteger(1, epk.copyOfRange(33, 65)),
                ),
                ecPublic.params,
            ),
        )
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(pair.private)
        agreement.doPhase(client, true)
        val shared = normalize(agreement.generateSecret())
        val transcript = MessageDigest.getInstance("SHA-256").digest(
            "loopra-relay-e2e/v1".toByteArray(Charsets.UTF_8) +
                epk + publicRaw + clientNonce + nonce,
        )
        fun key(label: String) = RelayCodec.hkdf(
            shared, code.toByteArray(Charsets.UTF_8),
            label.toByteArray(Charsets.UTF_8) + transcript, 32,
        )
        cipher = RelayCipher(key("s2c|"), key("c2s|"))
        expectedCi = RelayCodec.encode(key("confirm-i|"))
        peerHello = JSONObject()
            .put("t", "hi")
            .put("epk", RelayCodec.encode(publicRaw))
            .put("n", RelayCodec.encode(nonce))
            .put("cr", RelayCodec.encode(key("confirm-r|")))
        return this
    }

    private var nonce: ByteArray = ByteArray(0)

    fun helloJson(): JSONObject = peerHello!!.let {
        if (confirmOverride != null) JSONObject(it.toString()).put("cr", confirmOverride) else it
    }

    fun confirmMatches(ok: JSONObject): Boolean =
        ok.optString("t") == "ok" && ok.optString("ci") == expectedCi

    fun cipher(): RelayCipher = cipher!!

    private fun unsigned(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }

    private fun normalize(raw: ByteArray): ByteArray = when {
        raw.size == 32 -> raw
        raw.size < 32 -> ByteArray(32 - raw.size) + raw
        else -> raw.copyOfRange(raw.size - 32, raw.size)
    }
}

/** 单个脚本化 socket：客户端文本帧驱动握手，二进制帧交给 PeerHandshake。 */
internal class ScriptedSocket(
    private val factory: ScriptedRelay,
    val listener: RelaySocketListener,
) : RelaySocket {
    var peer: PeerHandshake? = null
    var opened = false
    var cancelled = false
    val receivedFrames = LinkedBlockingQueue<JSONObject>()
    val sentTexts = LinkedBlockingQueue<String>()

    override fun sendText(text: String): Boolean {
        if (cancelled) return false
        sentTexts.add(text)
        factory.answerText?.invoke(this, text)
        return true
    }

    override fun sendBinary(bytes: ByteArray): Boolean {
        if (cancelled) return false
        val frame = try {
            peer?.cipher()?.open(bytes)
        } catch (error: Exception) {
            null
        } ?: return false
        receivedFrames.add(frame)
        if (frame.optString("path") == "/api/mobile/handshake") {
            factory.handshakeFrame(this, frame)
        } else {
            factory.onFrame?.invoke(this, frame)
        }
        return true
    }

    override fun cancel() {
        cancelled = true
    }

    fun open() {
        opened = true
        listener.onOpen(this)
    }

    fun deliverFrame(frame: JSONObject) {
        listener.onBinary(peer!!.cipher().seal(frame))
    }

    fun fail() = listener.onFailure("中继已断开，正在重新连接")
    fun close() = listener.onClosed("中继已断开，正在重新连接")

    /** 完成一次隧道内请求：hres + 可选 body 块 + hend。 */
    fun finish(id: String, body: ByteArray = ByteArray(0), type: String = "application/octet-stream") {
        deliverFrame(JSONObject().put("t", "hres").put("id", id).put("status", 200)
            .put("headers", JSONObject().put("content-type", type)))
        if (body.isNotEmpty()) {
            deliverFrame(JSONObject().put("t", "hchunk").put("id", id)
                .put("b", RelayCodec.encode(body)))
        }
        deliverFrame(JSONObject().put("t", "hend").put("id", id))
    }
}

/** 脚本化中继：每次 open() 产生新 socket；answerText/onFrame 控制对端行为。 */
internal class ScriptedRelay(val code: String) : RelaySocketFactory {
    val sockets = CopyOnWriteArrayList<ScriptedSocket>()
    var answerText: ((ScriptedSocket, String) -> Unit)? = { socket, text -> defaultText(socket, text) }
    var onFrame: ((ScriptedSocket, JSONObject) -> Unit)? = null
    var corruptConfirm = false

    override fun open(url: String, listener: RelaySocketListener): RelaySocket {
        val socket = ScriptedSocket(this, listener)
        sockets.add(socket)
        socket.open()
        return socket
    }

    private fun defaultText(socket: ScriptedSocket, text: String) {
        val json = JSONObject(text)
        when (json.optString("t")) {
            "hi" -> {
                socket.peer = PeerHandshake(code)
                    .also { if (corruptConfirm) it.confirmOverride = RelayCodec.encode(ByteArray(32)) }
                    .acceptHello(json)
                socket.listener.onText(socket.peer!!.helloJson().toString())
            }
            "ok" -> {
                check(socket.peer!!.confirmMatches(json)) { "initiator authentication" }
                // ok 后客户端发 __handshake GET；在二进制路径处理。
            }
            else -> socket.fail()
        }
    }

    /** 内部隧道帧：__handshake GET 协议检查与 __probe HEAD 探测总是自动应答。 */
    fun handshakeFrame(socket: ScriptedSocket, frame: JSONObject) {
        when (frame.optString("method")) {
            "HEAD" -> {
                socket.deliverFrame(JSONObject().put("t", "hres").put("id", frame.optString("id")).put("status", 200))
                socket.deliverFrame(JSONObject().put("t", "hend").put("id", frame.optString("id")))
            }
            else -> socket.finish(
                frame.optString("id"),
                """{"success":true,"data":{"protocol":"loopra-relay","version":1}}""".toByteArray(),
                "application/json",
            )
        }
    }
}

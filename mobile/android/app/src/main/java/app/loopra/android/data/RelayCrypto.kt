package app.loopra.android.data

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.EllipticCurve
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.io.encoding.ExperimentalEncodingApi
import org.json.JSONObject

/** 加密协议不可信输入错误；消息与 Rust `crypto.rs` 的提示一致。 */
internal class RelayCryptoException(message: String) : Exception(message)

private const val E2E_LABEL = "loopra-relay-e2e/v1"
private val UTF8 = Charsets.UTF_8

/** 规范 URL-safe 无填充 Base64 与 RFC5869 HKDF-SHA256。 */
internal object RelayCodec {
    @OptIn(ExperimentalEncodingApi::class)
    private val codec = kotlin.io.encoding.Base64.UrlSafe
        .withPadding(kotlin.io.encoding.Base64.PaddingOption.ABSENT)
    private val urlSafePattern = Regex("[A-Za-z0-9_-]*")

    fun encode(raw: ByteArray): String = codec.encode(raw)

    fun decode(raw: String): ByteArray {
        if (raw.length % 4 == 1 || !raw.matches(urlSafePattern)) {
            throw RelayCryptoException("中继数据编码无效")
        }
        val bytes = try {
            codec.decode(raw)
        } catch (error: IllegalArgumentException) {
            throw RelayCryptoException("中继数据编码无效")
        }
        // 规范形式：末尾空白比特必须为零，与非规范编码区分开。
        if (codec.encode(bytes) != raw) throw RelayCryptoException("中继数据编码无效")
        return bytes
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 0..255 * 32) { "HKDF 输出长度超出 RFC5869 上限" }
        // extract：空盐按 RFC5869 使用 HashLen 个零字节。
        val prk = hmac(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val out = ByteArrayOutputStream()
        var previous = ByteArray(0)
        var index = 1
        while (out.size() < length) {
            previous = hmac(prk, previous + info + byteArrayOf(index.toByte()))
            out.write(previous)
            index++
        }
        return out.toByteArray().copyOf(length)
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256")
            .apply { init(SecretKeySpec(key, "HmacSHA256")) }
            .doFinal(data)

    /** 隧道路由标识：b64url(HKDF(code, salt=LABEL/routing, info="", 16))。 */
    fun routingId(code: String): String = encode(
        hkdf(
            code.toByteArray(UTF8),
            "$E2E_LABEL/routing".toByteArray(UTF8),
            ByteArray(0),
            16,
        ),
    )
}

private fun unsigned32(value: BigInteger): ByteArray {
    val raw = value.toByteArray()
    return when {
        raw.size == 32 -> raw
        raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
        else -> ByteArray(32 - raw.size) + raw
    }
}

/**
 * E2E 握手的发起方一半：临时 P-256 密钥对 + 16 字节随机数。
 * 与 Rust `Handshake` 一致：hi -> 验证对方 hi -> ECDH -> transcript 哈希 ->
 * 各标签 HKDF 派生 AES-GCM 密钥，confirm-r 常数时间校验。
 */
internal class RelayHandshake {
    private val privateKey: java.security.PrivateKey
    private val public: ByteArray
    private val nonce: ByteArray
    private val params: ECParameterSpec

    init {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
        val pair = generator.generateKeyPair()
        privateKey = pair.private
        val ecPublic = pair.public as ECPublicKey
        params = ecPublic.params
        public = byteArrayOf(4) + unsigned32(ecPublic.w.affineX) + unsigned32(ecPublic.w.affineY)
        nonce = ByteArray(16).also(SecureRandom()::nextBytes)
    }

    fun hello(): JSONObject = JSONObject()
        .put("t", "hi")
        .put("epk", RelayCodec.encode(public))
        .put("n", RelayCodec.encode(nonce))

    /** 完成握手：返回就绪的会话加密器与要发给对端的 ok 确认帧。 */
    fun finish(code: String, answer: JSONObject): RelayHandshakeResult {
        if (answer.opt("t") != "hi") throw RelayCryptoException("桌面加密协议不兼容")
        if (answer.has("bin")) {
            val bin = answer.opt("bin")
            val zero = (bin is Int && bin == 0) || (bin is Long && bin == 0L)
            if (!zero) throw RelayCryptoException("桌面加密协议不兼容")
        }
        val peerPublic = RelayCodec.decode(
            answer.opt("epk") as? String ?: throw RelayCryptoException("桌面握手数据无效"),
        )
        val peerNonce = RelayCodec.decode(
            answer.opt("n") as? String ?: throw RelayCryptoException("桌面握手数据无效"),
        )
        if (peerPublic.size != 65 || peerPublic[0].toInt() != 4 || peerNonce.size != 16) {
            throw RelayCryptoException("桌面握手数据无效")
        }
        val shared = agree(peerPublic)
        val transcript = MessageDigest.getInstance("SHA-256").digest(
            E2E_LABEL.toByteArray(UTF8) + public + peerPublic + nonce + peerNonce,
        )
        fun key(label: String): ByteArray = RelayCodec.hkdf(
            shared,
            code.toByteArray(UTF8),
            label.toByteArray(UTF8) + transcript,
            32,
        )
        val expected = key("confirm-r|")
        val received = try {
            RelayCodec.decode(answer.opt("cr") as? String ?: "")
        } catch (error: RelayCryptoException) {
            throw RelayCryptoException("桌面身份验证失败，请扫描当前配对码")
        }
        if (received.size != 32 || !MessageDigest.isEqual(expected, received)) {
            throw RelayCryptoException("桌面身份验证失败，请扫描当前配对码")
        }
        return RelayHandshakeResult(
            session = RelayCipher(key("c2s|"), key("s2c|")),
            confirm = JSONObject()
                .put("t", "ok")
                .put("ci", RelayCodec.encode(key("confirm-i|"))),
        )
    }

    private fun agree(peerPublic: ByteArray): ByteArray {
        val x = BigInteger(1, peerPublic.copyOfRange(1, 33))
        val y = BigInteger(1, peerPublic.copyOfRange(33, 65))
        // 先做显式曲线上点检查：拒绝越域或非曲线点，不依赖 provider 差异。
        if (!onCurve(params.curve, x, y)) throw RelayCryptoException("桌面握手公钥无效")
        return try {
            val peer = KeyFactory.getInstance("EC")
                .generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
            val agreement = KeyAgreement.getInstance("ECDH")
            agreement.init(privateKey)
            agreement.doPhase(peer, true)
            // JCA 返回的共享秘密左对齐字段长度；统一为 32 字节大端。
            normalize32(agreement.generateSecret())
        } catch (error: Exception) {
            throw RelayCryptoException("桌面握手公钥无效")
        }
    }

    companion object {
        private fun normalize32(raw: ByteArray): ByteArray = when {
            raw.size == 32 -> raw
            raw.size < 32 -> ByteArray(32 - raw.size) + raw
            else -> raw.copyOfRange(raw.size - 32, raw.size)
        }

        /** y² ≡ x³ + a·x + b (mod p)，且两个坐标都在素域内。 */
        private fun onCurve(curve: EllipticCurve, x: BigInteger, y: BigInteger): Boolean {
            val p = (curve.field as? ECFieldFp)?.p ?: return false
            if (x.signum() < 0 || x >= p || y.signum() < 0 || y >= p) return false
            val left = y.multiply(y).mod(p)
            val right = x.modPow(BigInteger.valueOf(3), p)
                .add(curve.a.multiply(x))
                .add(curve.b)
                .mod(p)
            return left == right
        }
    }
}

internal class RelayHandshakeResult(val session: RelayCipher, val confirm: JSONObject)

/**
 * AES-256-GCM 双向加密会话：iv = 4 个零字节 || 64 位大端计数器，
 * 帧 = iv || 密文 || tag；严格单调计数，越界/乱序/篡改都显式失败。
 */
internal class RelayCipher(sendKey: ByteArray, receiveKey: ByteArray) {
    private val sendKey = SecretKeySpec(sendKey, "AES")
    private val receiveKey = SecretKeySpec(receiveKey, "AES")
    private var sendCounter: ULong? = 0uL
    private var receiveCounter: ULong? = 0uL

    @Synchronized
    fun seal(frame: JSONObject): ByteArray {
        val counter = sendCounter ?: throw RelayCryptoException("加密会话已过期，请重新连接")
        val iv = iv(counter)
        val body = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, sendKey, GCMParameterSpec(128, iv))
            }.doFinal(frame.toString().toByteArray(UTF8))
        } catch (error: Exception) {
            throw RelayCryptoException("请求加密失败")
        }
        sendCounter = if (counter == ULong.MAX_VALUE) null else counter + 1uL
        return iv + body
    }

    @Synchronized
    fun open(wire: ByteArray): JSONObject {
        if (wire.size < 28 || wire.size > 8 shl 20) throw RelayCryptoException("加密帧无效")
        val counter = receiveCounter ?: throw RelayCryptoException("加密会话已过期，请重新连接")
        val expected = iv(counter)
        if (!MessageDigest.isEqual(expected, wire.copyOfRange(0, 12))) {
            throw RelayCryptoException("加密帧顺序无效")
        }
        val raw = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, receiveKey, GCMParameterSpec(128, expected))
            }.doFinal(wire, 12, wire.size - 12)
        } catch (error: Exception) {
            throw RelayCryptoException("加密帧认证失败")
        }
        val frame = try {
            JSONObject(String(raw, UTF8))
        } catch (error: Exception) {
            throw RelayCryptoException("隧道响应无效")
        }
        receiveCounter = if (counter == ULong.MAX_VALUE) null else counter + 1uL
        return frame
    }

    private fun iv(counter: ULong): ByteArray =
        ByteBuffer.allocate(12).putInt(0).putLong(counter.toLong()).array()

    companion object {
        const val MAX_WIRE_BYTES = 8 shl 20
    }
}

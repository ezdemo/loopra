package app.loopra.android

import app.loopra.android.data.RelayCodec
import app.loopra.android.data.RelayCryptoException
import app.loopra.android.data.RelayCipher
import app.loopra.android.data.RelayHandshake
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayCryptoTest {

    private val code = "A".repeat(43)

    private fun peerHello(hello: JSONObject, useCode: String = code): PeerHandshake {
        return PeerHandshake(useCode).acceptHello(hello)
    }

    /** 应答方握手：复用与测试夹具相同的独立实现（见 ScriptedRelay）。 */
    private fun handshakes(peerCode: String = code): Pair<RelayHandshake, PeerHandshake> {
        val initiator = RelayHandshake()
        val peer = peerHello(initiator.hello(), peerCode)
        return initiator to peer
    }

    private fun sessions(): Pair<RelayCipher, RelayCipher> {
        val (initiator, peer) = handshakes()
        val result = initiator.finish(code, peer.helloJson())
        return result.session to peer.cipher()
    }

    @Test
    fun routingIdUsesCodeHkdf() {
        // 与 fixture 同一推导：b64url(HKDF(UTF8(code), "loopra-relay-e2e/v1/routing", "", 16))。
        assertEquals(22, RelayCodec.routingId(code).length)
        assertEquals(
            RelayCodec.routingId(code),
            RelayCodec.routingId(String(code.toCharArray())),
        )
    }

    @Test
    fun sealOpenRoundTripBetweenDirections() {
        val (client, peer) = sessions()
        val frame = JSONObject().put("t", "hreq").put("id", "a").put("b", RelayCodec.encode(byteArrayOf(1, 2)))
        val wire = client.seal(frame)
        assertEquals(frame.toString(), peer.open(wire).toString())
        val reply = JSONObject().put("t", "hres").put("id", "a").put("status", 200)
        assertEquals(reply.toString(), client.open(peer.seal(reply)).toString())
    }

    @Test
    fun wireIsIvPrefixPlusTag() {
        val (client, _) = sessions()
        val wire = client.seal(JSONObject().put("t", "x"))
        // 12 字节 iv（前 4 字节为零、计数器 0）+ JSON + 16 字节 tag。
        assertTrue(wire.size > 28)
        assertArrayEquals(byteArrayOf(0, 0, 0, 0), wire.copyOfRange(0, 4))
        assertArrayEquals(ByteArray(8), wire.copyOfRange(4, 12))
    }

    @Test
    fun tamperedCiphertextFails() {
        val (client, peer) = sessions()
        val wire = client.seal(JSONObject().put("t", "x"))
        wire[20] = (wire[20] + 1).toByte()
        assertThrows(RelayCryptoException::class.java) { peer.open(wire) }
    }

    @Test
    fun tamperedIvFails() {
        val (client, peer) = sessions()
        val wire = client.seal(JSONObject().put("t", "x"))
        wire[4] = 1
        assertThrows(RelayCryptoException::class.java) { peer.open(wire) }
    }

    @Test
    fun replayedFrameFails() {
        val (client, peer) = sessions()
        val wire = client.seal(JSONObject().put("t", "x"))
        peer.open(wire)
        assertThrows(RelayCryptoException::class.java) { peer.open(wire) }
    }

    @Test
    fun outOfOrderFrameFails() {
        val (client, peer) = sessions()
        client.seal(JSONObject().put("t", "one"))
        val second = client.seal(JSONObject().put("t", "two"))
        assertThrows(RelayCryptoException::class.java) { peer.open(second) }
    }

    @Test
    fun undersizedWireFails() {
        val (client, _) = sessions()
        assertThrows(RelayCryptoException::class.java) { client.open(ByteArray(27)) }
    }

    @Test
    fun oversizedWireFails() {
        val (client, _) = sessions()
        assertThrows(RelayCryptoException::class.java) { client.open(ByteArray((8 shl 20) + 1)) }
    }

    @Test
    fun handshakeConfirmsPeer() {
        val initiator = RelayHandshake()
        val peer = peerHello(initiator.hello())
        val result = initiator.finish(code, peer.helloJson())
        assertTrue(peer.confirmMatches(result.confirm))
    }

    @Test
    fun wrongCodeFailsAuthentication() {
        val initiator = RelayHandshake()
        val peer = peerHello(initiator.hello())
        val error = assertThrows(RelayCryptoException::class.java) {
            initiator.finish("B".repeat(43), peer.helloJson())
        }
        assertTrue(error.message!!.contains("身份验证失败"))
    }

    @Test
    fun tamperedConfirmFailsAuthentication() {
        val initiator = RelayHandshake()
        val peer = peerHello(initiator.hello())
        val hello = peer.helloJson().put("cr", RelayCodec.encode(ByteArray(32)))
        val error = assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, hello)
        }
        assertTrue(error.message!!.contains("身份验证失败"))
    }

    @Test
    fun wrongTypePeerHelloFails() {
        val initiator = RelayHandshake()
        assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, JSONObject().put("t", "nope"))
        }
    }

    @Test
    fun nonZeroBinFails() {
        val initiator = RelayHandshake()
        val hello = peerHello(initiator.hello()).helloJson().put("bin", 1)
        assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, hello)
        }
    }

    @Test
    fun shortPeerKeyFails() {
        val initiator = RelayHandshake()
        val hello = peerHello(initiator.hello()).helloJson()
        hello.put("epk", RelayCodec.encode(ByteArray(64).also { it[0] = 4 }))
        assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, hello)
        }
    }

    @Test
    fun wrongPeerKeyPrefixFails() {
        val initiator = RelayHandshake()
        val hello = peerHello(initiator.hello()).helloJson()
        val raw = RelayCodec.decode(hello.optString("epk"))
        raw[0] = 3
        hello.put("epk", RelayCodec.encode(raw))
        assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, hello)
        }
    }

    @Test
    fun offCurvePeerKeyFails() {
        val initiator = RelayHandshake()
        val hello = peerHello(initiator.hello()).helloJson()
        val raw = RelayCodec.decode(hello.optString("epk"))
        raw[64] = (raw[64] + 1).toByte() // 扰动 y 坐标：几乎必然离曲线
        hello.put("epk", RelayCodec.encode(raw))
        assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, hello)
        }
    }

    @Test
    fun outOfFieldPeerKeyFails() {
        val initiator = RelayHandshake()
        val hello = peerHello(initiator.hello()).helloJson()
        val raw = RelayCodec.decode(hello.optString("epk"))
        java.util.Arrays.fill(raw, 33, 65, 0xFF.toByte()) // y >= p
        hello.put("epk", RelayCodec.encode(raw))
        assertThrows(RelayCryptoException::class.java) {
            initiator.finish(code, hello)
        }
    }

    @Test
    fun codecRejectsNonCanonicalInput() {
        assertThrows(RelayCryptoException::class.java) { RelayCodec.decode("A") }
        assertThrows(RelayCryptoException::class.java) { RelayCodec.decode("AAA+") }
        assertThrows(RelayCryptoException::class.java) { RelayCodec.decode("AAAA=") }
    }
}

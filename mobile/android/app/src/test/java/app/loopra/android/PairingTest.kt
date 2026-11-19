package app.loopra.android

import app.loopra.android.data.Pairing
import app.loopra.android.data.PairingException
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PairingTest {

    private val code = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))

    private fun link(
        relay: String = "https://relay.example.com",
        k: String = code,
        v: String = "1",
        e2e: String = "1",
    ): String = "loopra://connect?u=${java.net.URLEncoder.encode(relay, "UTF-8")}&k=$k&v=$v&e2e=$e2e"

    @Test
    fun validHttpsLink() {
        val pairing = Pairing.parse(link())
        assertEquals("https://relay.example.com", pairing.relayUrl)
        assertEquals(code, pairing.connectCode)
        assertEquals(1, pairing.version)
    }

    @Test
    fun validLinkWithPort() {
        val pairing = Pairing.parse(link(relay = "https://relay.example.com:8443"))
        assertEquals("https://relay.example.com:8443", pairing.relayUrl)
    }

    @Test
    fun rejectsWrongScheme() {
        assertFails { Pairing.parse(link().replace("loopra://", "https://")) }
    }

    @Test
    fun rejectsWrongHost() {
        assertFails { Pairing.parse(link().replace("connect", "other")) }
    }

    @Test
    fun rejectsWrongVersion() {
        assertFails { Pairing.parse(link(v = "2")) }
        assertFails { Pairing.parse(link(v = "x")) }
    }

    @Test
    fun rejectsWrongE2e() {
        assertFails { Pairing.parse(link(e2e = "0")) }
        assertFails { Pairing.parse("loopra://connect?u=https%3A%2F%2Frelay.example.com&k=$code&v=1") }
    }

    @Test
    fun rejectsDuplicateParams() {
        assertFails { Pairing.parse(link() + "&k=other") }
        assertFails { Pairing.parse(link() + "&v=1") }
        assertFails { Pairing.parse(link() + "&e2e=1") }
        assertFails { Pairing.parse(link() + "&u=https%3A%2F%2Fother.example.com") }
    }

    @Test
    fun rejectsMissingParams() {
        assertFails { Pairing.parse("loopra://connect?u=https%3A%2F%2Frelay.example.com&v=1&e2e=1") }
    }

    @Test
    fun rejectsNoncanonicalCode() {
        // 带 padding、标准 base64 字符或改写字母大小写都不是规范 URLsafe 编码。
        assertFails { Pairing.parse(link(k = "$code=")) }
        assertFails { Pairing.parse(link(k = code + "+")) }
        assertFails { Pairing.parse(link(k = code.lowercase())) }
        // 31 字节长度不符。
        assertFails {
            Pairing.parse(link(k = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(31))))
        }
    }

    @Test
    fun rejectsRelayCredentialsAndPath() {
        assertFails { Pairing.parse(link(relay = "https://user@relay.example.com")) }
        assertFails { Pairing.parse(link(relay = "https://user:pass@relay.example.com")) }
        assertFails { Pairing.parse(link(relay = "https://relay.example.com/api")) }
        assertFails { Pairing.parse(link(relay = "https://relay.example.com?x=1")) }
        assertFails { Pairing.parse(link(relay = "https://relay.example.com#frag")) }
    }

    @Test
    fun relayHttpOnlyForLoopback() {
        assertFails { Pairing.parse(link(relay = "http://relay.example.com")) }
        assertEquals("http://localhost", Pairing.parse(link(relay = "http://localhost")).relayUrl)
        assertEquals("http://localhost:8080", Pairing.parse(link(relay = "http://localhost:8080")).relayUrl)
        assertEquals("http://127.0.0.1", Pairing.parse(link(relay = "http://127.0.0.1")).relayUrl)
    }

    @Test
    fun rejectsNonHttpsEvenLocalWithUserinfo() {
        assertFails { Pairing.parse(link(relay = "http://user@localhost")) }
    }

    @Test
    fun rejectsOversizedAndMalformed() {
        assertFails { Pairing.parse(link() + "x".repeat(4096)) }
        assertFails { Pairing.parse("not a link") }
        assertFails { Pairing.parse("") }
    }

    @Test
    fun jsonRoundTrip() {
        val pairing = Pairing.parse(link())
        val restored = Pairing.fromJson(pairing.toJson())
        assertEquals(pairing, restored)
    }

    @Test
    fun displayNameNormalized() {
        val long = "a".repeat(60)
        val pairing = Pairing.validate("https://relay.example.com", code, 1, "  $long\n\t")
        assertTrue(pairing.displayName!!.length <= 40)
        assertNull(Pairing.validate("https://relay.example.com", code, 1, "   ").displayName)
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            fail("expected PairingException")
        } catch (expected: PairingException) {
        }
    }
}

package site.sorghum.loopra.bin.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.net.Proxy;
import java.net.ProxySelector;
import java.net.URI;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProxySettingsTest {

    @AfterEach
    void restoreSystemProxyProperties() {
        ProxySettings.apply("");
    }

    @Test
    void normalizesHttpAndSocksAddresses() {
        assertEquals("http://127.0.0.1:7890", ProxySettings.normalize("127.0.0.1:7890"));
        assertEquals("socks5://localhost:1080", ProxySettings.normalize("socks5://localhost:1080"));
        assertEquals("socks5://localhost:1080", ProxySettings.normalize("socks5h://localhost:1080"));
    }

    @Test
    void appliesHttpProxyToBothHttpAndHttpsRequests() {
        ProxySettings.apply("http://127.0.0.1:7890");

        assertEquals("127.0.0.1", System.getProperty("http.proxyHost"));
        assertEquals("7890", System.getProperty("http.proxyPort"));
        assertEquals("127.0.0.1", System.getProperty("https.proxyHost"));
        assertEquals("7890", System.getProperty("https.proxyPort"));
        assertTrue(System.getProperty("http.nonProxyHosts", "").contains("127.*"));
        assertNull(System.getProperty("socksProxyHost"));
        assertEquals(Proxy.Type.HTTP, ProxySelector.getDefault()
                .select(URI.create("https://api.example.test"))
                .get(0).type());
        assertEquals(Proxy.NO_PROXY, ProxySelector.getDefault()
                .select(URI.create("http://127.0.0.1:4567"))
                .get(0));
        assertEquals("http://127.0.0.1:7890", ProxySettings.currentAddress());
    }

    @Test
    void appliesSocksProxyAndCanBeCleared() {
        ProxySettings.apply("socks5://127.0.0.1:1080");

        assertNull(System.getProperty("http.proxyHost"));
        assertNull(System.getProperty("https.proxyHost"));
        assertEquals("127.0.0.1", System.getProperty("socksProxyHost"));
        assertEquals("1080", System.getProperty("socksProxyPort"));

        ProxySettings.apply("");
        assertEquals("", ProxySettings.currentAddress());
    }

    @Test
    void rejectsUnsupportedOrMalformedAddresses() {
        assertThrows(IllegalArgumentException.class, () -> ProxySettings.normalize("https://127.0.0.1:7890"));
        assertThrows(IllegalArgumentException.class, () -> ProxySettings.normalize("http://127.0.0.1:70000"));
        assertThrows(IllegalArgumentException.class, () -> ProxySettings.normalize("http://user:pass@127.0.0.1:7890"));
    }
}

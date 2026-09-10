package site.sorghum.loopra.bin.config;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 将用户配置的代理地址应用到 JVM 的标准代理属性。
 *
 * <p>JDK HttpClient、HttpURLConnection 以及使用默认 ProxySelector 的 OkHttp
 * 都会读取这些属性，因此 Java 侧的出站请求可以共享同一份代理配置。</p>
 */
public final class ProxySettings {

    private static final String HTTP_PROXY_HOST = "http.proxyHost";
    private static final String HTTP_PROXY_PORT = "http.proxyPort";
    private static final String HTTPS_PROXY_HOST = "https.proxyHost";
    private static final String HTTPS_PROXY_PORT = "https.proxyPort";
    private static final String SOCKS_PROXY_HOST = "socksProxyHost";
    private static final String SOCKS_PROXY_PORT = "socksProxyPort";
    private static final String HTTP_NON_PROXY_HOSTS = "http.nonProxyHosts";
    private static final String SOCKS_NON_PROXY_HOSTS = "socksNonProxyHosts";
    private static final String LOCAL_NON_PROXY_HOSTS = "localhost|127.*|[::1]|::1";
    private static final Set<String> HTTP_SCHEMES = Set.of("http");
    private static final Set<String> SOCKS_SCHEMES = Set.of("socks", "socks4", "socks5", "socks5h");
    private static final Map<String, String> ORIGINAL_PROPERTIES = captureOriginalProperties();

    private static volatile String currentAddress = "";

    private ProxySettings() {
    }

    /**
     * 应用代理配置。传入空字符串会关闭本应用设置的代理，并恢复 JVM 启动时的属性。
     *
     * @param rawAddress 例如 {@code 127.0.0.1:7890}、{@code http://127.0.0.1:7890}
     *                   或 {@code socks5://127.0.0.1:1080}
     */
    public static synchronized void apply(String rawAddress) {
        ProxyEndpoint endpoint = parse(rawAddress);
        restoreOriginalProperties();

        if (endpoint == null) {
            currentAddress = "";
            return;
        }

        if (endpoint.socks()) {
            clearProperties(HTTP_PROXY_HOST, HTTP_PROXY_PORT, HTTPS_PROXY_HOST, HTTPS_PROXY_PORT,
                    HTTP_NON_PROXY_HOSTS);
            setProperty(SOCKS_PROXY_HOST, endpoint.host());
            setProperty(SOCKS_PROXY_PORT, Integer.toString(endpoint.port()));
            setProperty(SOCKS_NON_PROXY_HOSTS, withLocalNonProxyHosts(SOCKS_NON_PROXY_HOSTS));
        } else {
            clearProperties(SOCKS_PROXY_HOST, SOCKS_PROXY_PORT, SOCKS_NON_PROXY_HOSTS);
            setProperty(HTTP_PROXY_HOST, endpoint.host());
            setProperty(HTTP_PROXY_PORT, Integer.toString(endpoint.port()));
            setProperty(HTTPS_PROXY_HOST, endpoint.host());
            setProperty(HTTPS_PROXY_PORT, Integer.toString(endpoint.port()));
            setProperty(HTTP_NON_PROXY_HOSTS, withLocalNonProxyHosts(HTTP_NON_PROXY_HOSTS));
        }
        currentAddress = endpoint.canonicalAddress();
    }

    /** 返回经过校验和规范化后的代理地址；空值表示关闭代理。 */
    public static String normalize(String rawAddress) {
        ProxyEndpoint endpoint = parse(rawAddress);
        return endpoint == null ? "" : endpoint.canonicalAddress();
    }

    /** 返回当前已应用的规范化代理地址。 */
    public static String currentAddress() {
        return currentAddress;
    }

    private static ProxyEndpoint parse(String rawAddress) {
        if (rawAddress == null || rawAddress.trim().isEmpty()) return null;

        String address = rawAddress.trim();
        if (!address.matches("^[A-Za-z][A-Za-z0-9+.-]*://.*$")) {
            address = "http://" + address;
        }

        final URI uri;
        try {
            uri = new URI(address);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("代理地址格式无效", e);
        }

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!HTTP_SCHEMES.contains(scheme) && !SOCKS_SCHEMES.contains(scheme)) {
            throw new IllegalArgumentException("代理协议仅支持 http 或 socks5");
        }
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) {
            throw new IllegalArgumentException("代理地址不应包含用户名、密码、路径或查询参数");
        }

        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("代理地址缺少主机名");
        }
        int port = uri.getPort();
        if (port < 0) port = SOCKS_SCHEMES.contains(scheme) ? 1080 : 80;
        if (port < 1 || port > 65535) {
            throw new IllegalArgumentException("代理端口必须在 1-65535 之间");
        }

        String normalizedScheme = SOCKS_SCHEMES.contains(scheme) ? "socks5" : "http";
        return new ProxyEndpoint(normalizedScheme, host, port, SOCKS_SCHEMES.contains(scheme));
    }

    private static Map<String, String> captureOriginalProperties() {
        Map<String, String> properties = new LinkedHashMap<>();
        for (String key : managedPropertyNames()) {
            properties.put(key, System.getProperty(key));
        }
        return Collections.unmodifiableMap(properties);
    }

    private static Set<String> managedPropertyNames() {
        return Set.of(
                HTTP_PROXY_HOST, HTTP_PROXY_PORT,
                HTTPS_PROXY_HOST, HTTPS_PROXY_PORT,
                SOCKS_PROXY_HOST, SOCKS_PROXY_PORT,
                HTTP_NON_PROXY_HOSTS, SOCKS_NON_PROXY_HOSTS
        );
    }

    private static String withLocalNonProxyHosts(String propertyName) {
        String original = ORIGINAL_PROPERTIES.get(propertyName);
        if (original == null || original.isBlank()) return LOCAL_NON_PROXY_HOSTS;
        return original + "|" + LOCAL_NON_PROXY_HOSTS;
    }

    private static void restoreOriginalProperties() {
        for (Map.Entry<String, String> entry : ORIGINAL_PROPERTIES.entrySet()) {
            setProperty(entry.getKey(), entry.getValue());
        }
    }

    private static void clearProperties(String... keys) {
        for (String key : keys) setProperty(key, null);
    }

    private static void setProperty(String key, String value) {
        if (value == null || value.isEmpty()) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }

    private record ProxyEndpoint(String scheme, String host, int port, boolean socks) {
        private String canonicalAddress() {
            String formattedHost = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
            return scheme + "://" + formattedHost + ":" + port;
        }
    }
}

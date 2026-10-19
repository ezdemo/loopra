package site.sorghum.loopra.bin.browser;

import org.noear.snack4.ONode;
import org.noear.solon.annotation.Component;

import java.net.URI;
import java.util.Locale;
import java.util.Set;

/** Electron 客户端在服务启动后登记的本机 AI 浏览器桥接地址。 */
@Component
public class AiBrowserBridgeService {
    private static final Set<String> LOCAL_HOSTS = Set.of("127.0.0.1", "localhost", "::1");
    private volatile String address = "";

    public String getAddress() {
        return address;
    }

    public synchronized String setAddress(String rawAddress) {
        if (rawAddress == null || rawAddress.isBlank()) {
            throw new IllegalArgumentException("浏览器桥接地址不能为空");
        }
        final URI uri;
        try {
            uri = URI.create(rawAddress.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("浏览器桥接地址格式无效");
        }
        String host = uri.getHost();
        if (!"http".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getPort() < 1 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("浏览器桥接地址必须是带端口的本机 HTTP 地址");
        }
        // Java 的 URI.getHost() 对 IPv6 返回带方括号的形式（如 [::1]），比较前先去掉方括号。
        String normalizedHost = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1)
                : host;
        if (!LOCAL_HOSTS.contains(normalizedHost.toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("浏览器桥接地址只能指向本机");
        }
        if (uri.getRawQuery() != null || uri.getRawFragment() != null || (uri.getPath() != null && !uri.getPath().isBlank() && !"/".equals(uri.getPath()))) {
            throw new IllegalArgumentException("浏览器桥接地址不能包含路径、查询参数或片段");
        }
        address = "http://" + host + ":" + uri.getPort();
        return address;
    }
    public static boolean isBrowserFailure(String result) {
        if (result == null) return false;
        if (result.startsWith("BROWSER_UNAVAILABLE:") || result.startsWith("BROWSER_ERROR:")) return true;
        try {
            ONode success = ONode.ofJson(result).get("success");
            return success != null && !success.isNull() && success.isValue() && !success.getBoolean();
        } catch (Exception ignored) {
            return false;
        }
    }
}

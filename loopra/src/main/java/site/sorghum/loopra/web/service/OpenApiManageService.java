package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;
import org.noear.solon.ai.talents.gateway.openapi.ApiAuthenticator;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.core.event.AppLoadEndEvent;
import org.noear.solon.core.event.EventListener;
import site.sorghum.loopra.tool.solon.openapi.LoopraOpenApiSkill;
import site.sorghum.loopra.web.model.OpenApiSourceDTO;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * OpenAPI 管理服务 —— 管理全局 OpenAPI 源的注册、查询和移除。
 * <p>
 * 配置持久化到 <code>~/.loopra/openapi-sources.json</code>，服务重启后自动恢复。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class OpenApiManageService implements EventListener<AppLoadEndEvent> {

    private static final String CONFIG_FILE = "openapi-sources.json";
    private final Map<String, OpenApiSourceDTO> registeredSources = new ConcurrentHashMap<>();
    @Inject
    private LoopraOpenApiSkill openApiSkill;

    /**
     * 初始化：从持久化文件加载已注册的 OpenAPI 源，并注册到 skill。
     */
    public void init() {
        List<OpenApiSourceDTO> sources = loadFromFile();
        for (OpenApiSourceDTO src : sources) {
            try {
                String apiBaseUrl = deriveBaseUrl(src.getDocUrl());
                ApiAuthenticator authenticator = buildAuthenticator(src.getAuthType(), src.getAuthConfig());
                openApiSkill.addApi(src.getDocUrl(), apiBaseUrl, src.getHeaders(), authenticator);
                registeredSources.put(src.getDocUrl(), src);
                log.debug("自动加载 OpenAPI 源: {}", src.getDocUrl());
            } catch (Exception e) {
                log.warn("自动加载 OpenAPI 源失败: {}", src.getDocUrl(), e);
            }
        }
        log.info("OpenAPI 源加载完成: {} 个", sources.size());
    }

    public List<OpenApiSourceDTO> getSources() {
        return new ArrayList<>(registeredSources.values());
    }

    public OpenApiSourceDTO addSource(String docUrl,
                                      Map<String, String> headers,
                                      String authType, Map<String, String> authConfig) {
        try {
            String apiBaseUrl = deriveBaseUrl(docUrl);
            ApiAuthenticator authenticator = buildAuthenticator(authType, authConfig);
            openApiSkill.addApi(docUrl, apiBaseUrl, headers, authenticator);
            OpenApiSourceDTO dto = OpenApiSourceDTO.ok(docUrl, headers, authType, authConfig);
            registeredSources.put(docUrl, dto);
            saveToFile();
            log.info("OpenAPI 源注册成功: {} (auth={})", docUrl, authType);
            return dto;
        } catch (Exception e) {
            log.error("OpenAPI 源注册失败: {}", docUrl, e);
            OpenApiSourceDTO dto = OpenApiSourceDTO.error(docUrl, e.getMessage());
            dto.setAuthType(authType);
            dto.setAuthConfig(authConfig);
            registeredSources.put(docUrl, dto);
            saveToFile();
            return dto;
        }
    }

    public OpenApiSourceDTO addSource(String docUrl, Map<String, String> headers) {
        return addSource(docUrl, headers, "none", null);
    }

    public boolean removeSource(String docUrl) {
        try {
            openApiSkill.removeApi(docUrl);
            registeredSources.remove(docUrl);
            saveToFile();
            log.info("OpenAPI 源已移除: {}", docUrl);
            return true;
        } catch (Exception e) {
            log.error("OpenAPI 源移除失败: {}", docUrl, e);
            return false;
        }
    }

    public OpenApiSourceDTO refreshSource(String docUrl,
                                          Map<String, String> headers,
                                          String authType, Map<String, String> authConfig) {
        try {
            openApiSkill.removeApi(docUrl);
        } catch (Exception ignored) {
        }
        return addSource(docUrl, headers, authType, authConfig);
    }

    public Object searchApis(String keyword) {
        try {
            return openApiSkill.searchApis(keyword);
        } catch (Exception e) {
            log.warn("搜索 OpenAPI 接口失败: {}", e.getMessage());
            return "搜索失败: " + e.getMessage();
        }
    }

    // ==================== 文件持久化 ====================

    private Path configPath() {
        return Paths.get(System.getProperty("user.home"), ".loopra", CONFIG_FILE);
    }

    private void saveToFile() {
        try {
            Path path = configPath();
            Files.createDirectories(path.getParent());
            String json = JsonWriter.write(ONode.ofBean(new ArrayList<>(registeredSources.values())), Options.of(Feature.Write_PrettyFormat));
            Files.writeString(path, json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.error("保存 OpenAPI 配置失败", e);
        }
    }

    private List<OpenApiSourceDTO> loadFromFile() {
        Path path = configPath();
        if (!Files.exists(path)) {
            return Collections.emptyList();
        }
        try {
            String json = Files.readString(path, StandardCharsets.UTF_8);
            OpenApiSourceDTO[] arr = ONode.ofJson(json).toBean(OpenApiSourceDTO[].class);
            return arr != null ? new ArrayList<>(Arrays.asList(arr)) : Collections.emptyList();
        } catch (Exception e) {
            log.warn("读取 OpenAPI 配置失败: {}", path, e);
            return Collections.emptyList();
        }
    }

    // ==================== 私有辅助 ====================

    private String deriveBaseUrl(String docUrl) {
        if (docUrl == null) return "";
        try {
            if (docUrl.startsWith("http://") || docUrl.startsWith("https://")) {
                java.net.URL url = new java.net.URL(docUrl);
                String base = url.getProtocol() + "://" + url.getHost();
                if (url.getPort() > 0 && url.getPort() != 80 && url.getPort() != 443) {
                    base += ":" + url.getPort();
                }
                return base;
            }
        } catch (Exception e) {
            log.warn("无法解析 docUrl 基地址: {}", docUrl);
        }
        return "";
    }

    private ApiAuthenticator buildAuthenticator(String authType, Map<String, String> authConfig) {
        if (authConfig == null || "none".equals(authType)) {
            return null;
        }
        return switch (authType) {
            case "bearer" -> {
                String token = authConfig.get("token");
                yield token != null && !token.isEmpty()
                        ? ApiAuthenticator.bearer(token)
                        : null;
            }
            case "apikey" -> {
                String name = authConfig.get("name");
                String value = authConfig.get("value");
                yield name != null && value != null && !name.isEmpty() && !value.isEmpty()
                        ? ApiAuthenticator.apiKey(name, value)
                        : null;
            }
            case "basic" -> {
                String username = authConfig.get("username");
                String password = authConfig.get("password");
                if (username != null && !username.isEmpty() && password != null) {
                    String encoded = Base64.getEncoder()
                            .encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8));
                    yield (http, tool) -> http.header("Authorization", "Basic " + encoded);
                }
                yield null;
            }
            default -> null;
        };
    }

    @Override
    public void onEvent(AppLoadEndEvent event) throws Throwable {
        init();
    }
}

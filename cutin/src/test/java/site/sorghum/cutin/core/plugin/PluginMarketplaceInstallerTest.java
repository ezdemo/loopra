package site.sorghum.cutin.core.plugin;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.cutin.core.json.JsonSupport;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;
import site.sorghum.cutin.plugins.PackageSamplePlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 插件市场与安装测试：验证从 HTTP 市场列出、下载并加载插件包。
 */
class PluginMarketplaceInstallerTest {

    /** 临时目录。 */
    @TempDir
    Path tempDir;

    /** 应能从市场列出插件、下载 JAR 并通过 ServiceLoader 加载生效。 */
    @Test
    void listsDownloadsAndLoadsRemotePluginPackage() throws Exception {
        byte[] jarBytes = buildPluginJar();
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();

        server.createContext("/marketplace", exchange -> {
            byte[] body = JsonSupport.write(Map.of("packages", List.of(Map.of(
                "id", "sample",
                "version", "1.0",
                "downloadUrl", baseUrl + "/plugin.jar"
            )))).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/plugin.jar", exchange -> {
            exchange.sendResponseHeaders(200, jarBytes.length);
            exchange.getResponseBody().write(jarBytes);
            exchange.close();
        });
        server.start();

        try {
            HttpPluginMarketplace marketplace = new HttpPluginMarketplace(
                java.net.URI.create(baseUrl + "/marketplace")
            );
            List<PluginPackageInfo> packages = marketplace.list();
            assertEquals(1, packages.size());

            Path pluginDirectory = tempDir.resolve("plugins");
            PluginInstaller installer = new PluginInstaller(pluginDirectory);
            Path installedJar = installer.install(packages.get(0));
            assertTrue(Files.exists(installedJar));

            DefaultLoopEngine engine = new DefaultLoopEngine();
            PluginBeanManager manager = new PluginBeanManager(engine.registrar());
            manager.discover(installedJar);
            manager.startAll();

            LoopProgram program = LoopProgram.builder("market-plugin")
                .node("finish", NodeType.CODE, Steps.finish())
                .build();
            LoopHandle handle = engine.run(program, Map.of());
            LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

            assertEquals(LoopResult.Status.COMPLETED, result.status());
            assertTrue(result.finalSnapshot().variables().containsKey("packagePluginApplied"));

            // 卸载插件以关闭类加载器，避免 Windows 下临时目录因文件锁无法删除
            manager.unregisterPlugin("package-sample");
        } finally {
            server.stop(0);
        }
    }

    private byte[] buildPluginJar() throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (JarOutputStream jar = new JarOutputStream(buffer)) {
            jar.putNextEntry(new JarEntry("META-INF/services/site.sorghum.cutin.core.plugin.LoopPlugin"));
            jar.write(("site.sorghum.cutin.plugins.PackageSamplePlugin" + System.lineSeparator())
                .getBytes(StandardCharsets.UTF_8));
            jar.closeEntry();

            String className = PackageSamplePlugin.class.getName().replace('.', '/') + ".class";
            jar.putNextEntry(new JarEntry(className));
            try (InputStream input = PackageSamplePlugin.class.getClassLoader().getResourceAsStream(className)) {
                input.transferTo(jar);
            }
            jar.closeEntry();
        }
        return buffer.toByteArray();
    }
}

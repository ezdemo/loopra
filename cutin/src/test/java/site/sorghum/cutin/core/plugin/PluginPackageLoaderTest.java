package site.sorghum.cutin.core.plugin;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 插件包加载测试：验证通过 ServiceLoader 服务文件发现插件。
 */
class PluginPackageLoaderTest {

    /** 临时插件包目录。 */
    @TempDir
    Path tempDir;

    /** 不依赖 YAML，仅凭 META-INF/services 文件即可发现并启动插件。 */
    @Test
    void discoversPluginFromServiceFileWithoutYaml() throws Exception {
        Path services = tempDir.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(
            services.resolve("site.sorghum.cutin.core.plugin.LoopPlugin"),
            "site.sorghum.cutin.plugins.PackageSamplePlugin" + System.lineSeparator(),
            StandardCharsets.UTF_8
        );

        DefaultLoopEngine engine = new DefaultLoopEngine();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.discover(tempDir);
        manager.startAll();

        LoopProgram program = LoopProgram.builder("package-plugin")
            .node("finish", NodeType.CODE, Steps.finish())
            .build();
        LoopHandle handle = engine.run(program, Map.of());
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue(result.finalSnapshot().variables().containsKey("packagePluginApplied"));
    }
}

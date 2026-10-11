package site.sorghum.loopra.bin.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;

import java.io.UncheckedIOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ConfigServicePersistenceTest {

    @TempDir
    Path home;
    private String previousHome;
    private Object previousConfig;
    private Object previousSingleton;

    @BeforeEach
    void isolateConfig() throws Exception {
        previousHome = System.getProperty("user.home");
        previousConfig = field(ConfigService.class, "config").get(null);
        previousSingleton = field(LoopraConfig.class, "INSTANCE").get(null);
        System.setProperty("user.home", home.toString());
        ConfigService.reload();
        ConfigService.setDisabledTools(List.of("existing"));
    }

    @AfterEach
    void restoreConfig() throws Exception {
        System.setProperty("user.home", previousHome);
        field(ConfigService.class, "config").set(null, previousConfig);
        field(LoopraConfig.class, "INSTANCE").set(null, previousSingleton);
    }

    @Test
    void failedSaveIsReportedAndDoesNotPublishTheStagedConfiguration() throws Exception {
        LoopraConfig original = ConfigService.getConfig();
        Path configPath = LoopraConfig.getConfigPath();
        Files.delete(configPath);
        Files.createDirectory(configPath);
        Files.writeString(configPath.resolve("block-replacement"), "occupied");

        assertThrows(UncheckedIOException.class, () -> ConfigService.setDisabledTools(List.of("replacement")));
        assertSame(original, ConfigService.getConfig());
        assertEquals(Set.of("existing"), original.disabledTools());
        assertThrows(UncheckedIOException.class, () -> ConfigService.updateConfig(Map.of("disabledTools", List.of("other"))));
        assertEquals(Set.of("existing"), original.disabledTools());
        assertThrows(UncheckedIOException.class, () -> ConfigService.removeConfigKey("disabledTools"));
        assertEquals(Set.of("existing"), original.disabledTools());
        assertNoTemporaryFiles();
    }

    @Test
    void successfulSavePublishesTheSameConfigurationThatWasPersisted() throws Exception {
        ConfigService.setDisabledTools(List.of("updated"));

        assertEquals(Set.of("updated"), ConfigService.getConfig().disabledTools());
        ONode persisted = ONode.ofJson(Files.readString(LoopraConfig.getConfigPath()));
        assertEquals("updated", persisted.get("disabledTools").get(0).getString());
        assertNoTemporaryFiles();
    }

    private void assertNoTemporaryFiles() throws Exception {
        try (var files = Files.list(home.resolve(".loopra"))) {
            assertFalse(files.anyMatch(path -> path.getFileName().toString().endsWith(".tmp")));
        }
    }

    private static Field field(Class<?> owner, String name) throws Exception {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
}

package site.sorghum.loopra.bin.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;

import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class LoopraConfigTest {

    @TempDir
    Path tempDir;

    @Test
    void createsDefaultConfigWithoutStoppingStartup() throws Exception {
        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();

            assertTrue(Files.exists(tempDir.resolve(".loopra/config.json")));
            assertEquals("", config.apiKey());
            assertEquals("chat_completions", config.activeModelChannel().apiProtocol());
            assertEquals("", config.activeModelChannel().specialCompatibility());
            assertEquals(tempDir.resolve(".loopra/defaultWorkSpace").toAbsolutePath().normalize(),
                    config.workspaceDir());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void assignsDefaultWorkspaceWhenExistingConfigOmitsWorkspace() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), "{}");

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();
            Path expectedWorkspace = configDir.resolve("defaultWorkSpace").toAbsolutePath().normalize();

            assertEquals(expectedWorkspace, config.workspaceDir());
            assertTrue(Files.isDirectory(expectedWorkspace));
            assertEquals(expectedWorkspace.toString(), ONode.ofJson(Files.readString(configDir.resolve("config.json")))
                    .select("$.workspaceDir").getString());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void buildsProtocolApiUrlForModelChannels() {
        assertEquals("https://api.example.com/v1/chat/completions",
                new LoopraConfig.ModelChannel("id", "name", "https://api.example.com/v1", "key", List.of()).apiUrl());
        assertEquals("https://api.example.com/v1/chat/completions",
                new LoopraConfig.ModelChannel("id", "name", "https://api.example.com/v1", "key",
                        "chat_completions", "opencode", List.of()).apiUrl());
        assertEquals("opencode",
                new LoopraConfig.ModelChannel("id", "name", "https://api.example.com/v1", "key",
                        "chat_completions", "opencode", List.of()).specialCompatibility());
        assertEquals("https://api.example.com/v1/responses",
                new LoopraConfig.ModelChannel("id", "name", "https://api.example.com/v1/", "key", "responses", List.of()).apiUrl());
        assertEquals("https://api.example.com/v1/responses",
                new LoopraConfig.ModelChannel("id", "name", "https://api.example.com/v1/chat/completions", "key", "responses", List.of()).apiUrl());
        assertEquals("https://api.example.com/v1/chat/completions",
                new LoopraConfig.ModelChannel("id", "name", "https://api.example.com/v1/responses", "key", List.of()).apiUrl());
        assertEquals("https://api.example.com/v1/responses?api-version=2025-04-01-preview",
                new LoopraConfig.ModelChannel("id", "name",
                        "https://api.example.com/v1/chat/completions?api-version=2025-04-01-preview",
                        "key", "responses", List.of()).apiUrl());
    }

    @Test
    void buildsAnthropicMessagesApiUrl() {
        assertEquals("https://api.anthropic.com/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.anthropic.com/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com/v1", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.anthropic.com/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com/v1/", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.anthropic.com/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com/v1/messages", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.anthropic.com/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com/chat/completions", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.anthropic.com/v1/messages?beta=true",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com?beta=true", "key", "anthropic", List.of()).apiUrl());
        // DeepSeek / 小米 MiMo 等兼容网关：baseUrl 已含 /anthropic 前缀
        assertEquals("https://api.deepseek.com/anthropic/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.deepseek.com/anthropic", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.xiaomimimo.com/anthropic/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.xiaomimimo.com/anthropic", "key", "anthropic", List.of()).apiUrl());
        assertEquals("https://api.xiaomimimo.com/anthropic/v1/messages",
                new LoopraConfig.ModelChannel("id", "name", "https://api.xiaomimimo.com/anthropic/v1/messages", "key", "anthropic", List.of()).apiUrl());
        // 非 anthropic 协议不受影响
        assertEquals("https://api.anthropic.com/v1/chat/completions",
                new LoopraConfig.ModelChannel("id", "name", "https://api.anthropic.com/v1", "key", List.of()).apiUrl());
    }

    @Test
    void migratesLegacyAgent4jDataExceptJreAndBin() throws Exception {
        Path legacyDir = tempDir.resolve(".agent4j");
        Files.createDirectories(legacyDir.resolve("sessions"));
        Files.createDirectories(legacyDir.resolve("jre"));
        Files.createDirectories(legacyDir.resolve("jre25/bin"));
        Files.createDirectories(legacyDir.resolve("bin"));
        Files.writeString(legacyDir.resolve("config.json"), "{\"apiKey\":\"legacy-key\"}");
        Files.writeString(legacyDir.resolve("sessions/session.jsonl"), "legacy session");
        Files.writeString(legacyDir.resolve("jre/excluded.txt"), "excluded");
        Files.writeString(legacyDir.resolve("jre25/bin/extnet.dll"), "excluded runtime");
        Files.writeString(legacyDir.resolve("bin/excluded.txt"), "excluded");

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();
            Path configDir = tempDir.resolve(".loopra");

            assertEquals("legacy-key", config.apiKey());
            assertEquals("legacy session", Files.readString(configDir.resolve("sessions/session.jsonl")));
            assertFalse(Files.exists(configDir.resolve("jre")));
            assertFalse(Files.exists(configDir.resolve("jre25")));
            assertFalse(Files.exists(configDir.resolve("bin")));
            assertTrue(Files.exists(configDir.resolve(".agent4j-migration-complete")));
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void migratesLegacyDataWhenInstallerAlreadyCreatedLoopraDirectory() throws Exception {
        Path legacyDir = tempDir.resolve(".agent4j");
        Files.createDirectories(legacyDir.resolve("sessions"));
        Files.writeString(legacyDir.resolve("config.json"), "{\"apiKey\":\"legacy-key\"}");
        Files.writeString(legacyDir.resolve("sessions/legacy.jsonl"), "legacy session");

        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir.resolve("bin"));
        Files.createDirectories(configDir.resolve("jre"));
        Files.writeString(configDir.resolve("bin/loopra.cmd"), "installed command");
        Files.writeString(configDir.resolve("jre/runtime.txt"), "installed runtime");
        Files.writeString(configDir.resolve("config.json"), "{\"apiKey\":\"\"}");

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();

            assertEquals("legacy-key", config.apiKey());
            assertEquals("legacy session", Files.readString(configDir.resolve("sessions/legacy.jsonl")));
            assertEquals("installed command", Files.readString(configDir.resolve("bin/loopra.cmd")));
            assertEquals("installed runtime", Files.readString(configDir.resolve("jre/runtime.txt")));
            assertTrue(Files.exists(configDir.resolve(".agent4j-migration-complete")));
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void overwritesExistingLoopraDataOnFirstLegacyMigration() throws Exception {
        Path legacyDir = tempDir.resolve(".agent4j");
        Files.createDirectories(legacyDir.resolve("sessions"));
        Files.writeString(legacyDir.resolve("config.json"), "{\"apiKey\":\"legacy-key\"}");
        Files.writeString(legacyDir.resolve("sessions/existing.jsonl"), "legacy existing session");
        Files.writeString(legacyDir.resolve("sessions/missing.jsonl"), "legacy missing session");

        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir.resolve("sessions"));
        Files.writeString(configDir.resolve("config.json"), "{\"apiKey\":\"current-key\"}");
        Files.writeString(configDir.resolve("sessions/existing.jsonl"), "current session");

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();

            assertEquals("legacy-key", config.apiKey());
            assertEquals("legacy existing session", Files.readString(configDir.resolve("sessions/existing.jsonl")));
            assertEquals("legacy missing session", Files.readString(configDir.resolve("sessions/missing.jsonl")));
            assertTrue(Files.exists(configDir.resolve(".agent4j-migration-complete")));

            Files.writeString(configDir.resolve("sessions/existing.jsonl"), "changed after migration");
            Files.writeString(legacyDir.resolve("sessions/existing.jsonl"), "changed legacy session");
            LoopraConfig.load();

            assertEquals("changed after migration", Files.readString(configDir.resolve("sessions/existing.jsonl")));
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void terminatesOnNoToolCallByDefault() throws Exception {
        assertTrue(config("{}").terminateOnNoToolCall());
    }

    @Test
    void supportsContinuingAfterNoToolCallWhenConfigured() throws Exception {
        assertFalse(config("{\"terminateOnNoToolCall\":false}").terminateOnNoToolCall());
    }

    @Test
    void usesDefaultMaxTokensWhenModelEntryOmitsIt() throws Exception {
        assertEquals(32768, config("{}").modelMaxTokens("main", "model"));
    }

    @Test
    void readsMaxTokensPerModelWithDefaultFallback() throws Exception {
        LoopraConfig config = config("""
                {"model":"large","modelChannelId":"main",
                 "modelChannels":[{"id":"main","models":[
                   {"name":"large","maxTokens":131072},
                   {"name":"small"}
                 ]}]}
                """);

        assertEquals(131072, config.modelMaxTokens("main", "large"));
        assertEquals(32768, config.modelMaxTokens("main", "small"));
        assertEquals(131072, config.activeModelMaxTokens());
    }

    @Test
    void readsSpecialCompatibilityPerChannel() throws Exception {
        LoopraConfig config = config("""
                {"model":"main","modelChannelId":"main",
                 "modelChannels":[{"id":"main","apiProtocol":"chat_completions",
                   "specialCompatibility":"opencode","models":[{"name":"main"}]}]}
                """);

        assertEquals("chat_completions", config.modelChannel("main").apiProtocol());
        assertEquals("opencode", config.modelChannel("main").specialCompatibility());
    }

    @Test
    void doesNotTreatProtocolNameAsSpecialCompatibility() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), """
                {"model":"main","modelChannelId":"main","modelChannels":[
                  {"id":"main","baseUrl":"https://example.test/v1","apiKey":"key",
                   "apiProtocol":"some_unknown_protocol","models":[{"name":"main"}]}
                ]}
                """);

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();

            assertEquals("chat_completions", config.modelChannel("main").apiProtocol());
            assertEquals("", config.modelChannel("main").specialCompatibility());
            ONode saved = ONode.ofJson(Files.readString(configDir.resolve("config.json")));
            assertEquals("chat_completions", saved.select("$.modelChannels[0].apiProtocol").getString());
            assertEquals("", saved.select("$.modelChannels[0].specialCompatibility").getString());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void removesLegacyGlobalMaxTokensWhenLoading() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), "{\"maxTokens\":65536}");

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig.load();

            ONode saved = ONode.ofJson(Files.readString(configDir.resolve("config.json")));
            assertFalse(saved.getObject().containsKey("maxTokens"));
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void readsContextCompactionDefaults() throws Exception {
        LoopraConfig config = config("{}");

        assertEquals(0.8, config.compactionThresholdRatio());
        assertEquals(0.16, config.compactionRetainRatio());
        assertEquals(1, config.compactionRetries());
        assertEquals(8192, config.toolResultPruneThresholdChars());
        assertEquals(4096, config.toolResultPruneHeadChars());
        assertEquals(1024, config.toolResultPruneTailChars());
    }

    @Test
    void readsContextCompactionOverrides() throws Exception {
        LoopraConfig config = config("""
                {"contextCompaction":{
                  "thresholdRatio":0.7,
                  "retainRatio":0.12,
                  "compactionRetries":2,
                  "toolResultPrune":{"thresholdChars":4096,"headChars":2048,"tailChars":256}
                }}
                """);

        assertEquals(0.7, config.compactionThresholdRatio());
        assertEquals(0.12, config.compactionRetainRatio());
        assertEquals(2, config.compactionRetries());
        assertEquals(4096, config.toolResultPruneThresholdChars());
        assertEquals(2048, config.toolResultPruneHeadChars());
        assertEquals(256, config.toolResultPruneTailChars());
    }

    @Test
    void migratesTaskToolConfigurationToSubAgent() throws Exception {
        LoopraConfig config = config("""
                {"autoWhitelist":["task","goal_mark_step","read"],"disabledTools":["task","goal_mark_step"]}
                """);

        assertTrue(config.autoWhitelist().contains("sub_agent"));
        assertTrue(config.autoWhitelist().contains("goal_update_step"));
        assertFalse(config.autoWhitelist().contains("task"));
        assertFalse(config.autoWhitelist().contains("goal_mark_step"));
        assertTrue(config.disabledTools().contains("sub_agent"));
        assertTrue(config.disabledTools().contains("goal_update_step"));
        assertFalse(config.disabledTools().contains("task"));
        assertFalse(config.disabledTools().contains("goal_mark_step"));
    }

    @Test
    void readsToolReadOnlyOverrides() throws Exception {
        LoopraConfig config = config("""
                {"toolReadOnlyOverrides":{"bash":true,"read":false,"ignored":"yes"}}
                """);

        assertEquals(Map.of("bash", true, "read", false), config.toolReadOnlyOverrides());
    }

    @Test
    void migratesLegacyChannelModelStringsToConfiguredEntries() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), """
                {"model":"legacy-model","modelChannelId":"main","modelChannels":[{
                  "id":"main","name":"Main","baseUrl":"https://example.test","apiKey":"secret-key",
                  "models":["legacy-model"]
                }]}
                """);

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();

            LoopraConfig.ModelChannel channel = config.modelChannel("main");
            assertEquals("chat_completions", channel.apiProtocol());
            assertEquals(List.of("legacy-model"), channel.models());
            assertEquals(-1, channel.modelEntry("legacy-model").contextTokens());
            assertFalse(channel.modelEntry("legacy-model").imageInput());

            ONode saved = ONode.ofJson(Files.readString(configDir.resolve("config.json")));
            assertEquals("chat_completions", saved.select("$.modelChannels[0].apiProtocol").getString());
            assertTrue(saved.select("$.modelChannels[0].models[0]").isObject());
            assertEquals("legacy-model", saved.select("$.modelChannels[0].models[0].name").getString());
            assertEquals(-1, saved.select("$.modelChannels[0].models[0].contextTokens").getInt());
            assertFalse(saved.select("$.modelChannels[0].models[0].imageInput").getBoolean());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void preservesRootResponsesProtocolWhenMigratingLegacyConfig() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), """
                {"baseUrl":"https://example.test/v1","apiKey":"secret-key","apiProtocol":"responses",
                 "model":"gpt-5","availableModels":["gpt-5"]}
                """);

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();

            assertEquals("responses", config.apiProtocol());
            assertEquals("https://example.test/v1/responses", config.apiUrl());
            assertEquals("responses", config.activeModelChannel().apiProtocol());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void savesObjectModelsAndRetainsMaskedChannelApiKey() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), """
                {"model":"vision-model","modelChannelId":"main","apiKey":"root-secret","modelChannels":[{
                  "id":"main","name":"Main","baseUrl":"https://example.test","apiKey":"secret-key",
                  "models":[{"name":"old","contextTokens":-1,"imageInput":false}]
                }]}
                """);

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();
            config.updateAndSave(Map.of(
                    "apiKey", "root****cret",
                    "modelChannels", List.of(Map.of(
                    "id", "main", "name", "Main", "baseUrl", "https://example.test", "apiKey", "secr****-key",
                            "apiProtocol", "responses",
                            "specialCompatibility", "opencode",
                            "models", List.of(Map.of("name", "vision-model", "contextTokens", 128000,
                                    "maxTokens", 65536, "imageInput", true,
                                    "price", Map.of("input", 1.5, "cache", 0.2, "output", 3)))
                    ))
            ));

            LoopraConfig saved = LoopraConfig.load();
            LoopraConfig.ModelEntry entry = saved.activeModelEntry();
            assertEquals("secret-key", saved.apiKey());
            assertEquals("secret-key", saved.modelChannel("main").apiKey());
            assertEquals("responses", saved.modelChannel("main").apiProtocol());
            assertEquals("opencode", saved.modelChannel("main").specialCompatibility());
            assertEquals(128000, entry.contextTokens());
            assertEquals(65536, entry.maxTokens());
            assertTrue(entry.imageInput());
            assertEquals(1.5, entry.price().get("input"));
            assertEquals(1.5, saved.price().get("vision-model").get("input"));

            ONode root = ONode.ofJson(Files.readString(configDir.resolve("config.json")));
            assertEquals("root-secret", root.select("$.apiKey").getString());
            assertTrue(root.select("$.modelChannels[0].models[0]").isObject());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    @Test
    void keepsLegacyRootPriceWhenChannelEntryHasNoPrice() throws Exception {
        LoopraConfig config = config("""
                {"model":"configured-model","modelChannelId":"main","price":{"configured-model":{"input":1.25}},
                 "modelChannels":[{"id":"main","models":[{"name":"configured-model","contextTokens":-1,"imageInput":false}]}]}
                """);

        assertEquals(1.25, config.price().get("configured-model").get("input"));
    }

    @Test
    void resolvesValidationModelAcrossChannels() throws Exception {
        LoopraConfig config = config("""
                {"validationModel":"guard-mini","validationModelChannelId":"guard",
                 "modelChannels":[
                   {"id":"main","models":[{"name":"main-model"}]},
                   {"id":"guard","baseUrl":"https://guard.test/v1","apiKey":"guard-key",
                    "apiProtocol":"responses","models":[{"name":"guard-mini"}]}
                 ]}
                """);

        assertEquals("guard-mini", config.validationModel());
        assertEquals("guard", config.validationModelChannelId());
        assertEquals("https://guard.test/v1/responses", config.validationModelChannel().apiUrl());
    }

    @Test
    void resolvesImageUnderstandingModelAcrossChannels() throws Exception {
        LoopraConfig config = config("""
                {"imageUnderstandingModel":"vision-mini","imageUnderstandingModelChannelId":"vision",
                 "modelChannels":[
                   {"id":"main","models":[{"name":"main-model","imageInput":false}]},
                   {"id":"vision","baseUrl":"https://vision.test/v1","apiKey":"vision-key",
                    "apiProtocol":"responses","models":[{"name":"vision-mini","imageInput":true}]}
                 ]}
                """);

        assertEquals("vision-mini", config.imageUnderstandingModel());
        assertEquals("vision", config.imageUnderstandingModelChannelId());
        assertTrue(config.imageUnderstandingModelChannel().modelEntry("vision-mini").imageInput());
        assertEquals("https://vision.test/v1/responses", config.imageUnderstandingModelChannel().apiUrl());
    }

    @Test
    void emptyValidationSelectionDisablesPersistedValidator() throws Exception {
        Path configDir = tempDir.resolve(".loopra");
        Files.createDirectories(configDir);
        Files.writeString(configDir.resolve("config.json"), """
                {"validationModel":"guard-mini","validationModelChannelId":"guard",
                 "imageUnderstandingModel":"vision-mini","imageUnderstandingModelChannelId":"vision",
                 "modelChannels":[{"id":"guard","models":[{"name":"guard-mini"}]}]}
                """);

        String originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", tempDir.toString());
        try {
            LoopraConfig config = LoopraConfig.load();
            config.updateAndSave(Map.of(
                    "validationModel", "", "validationModelChannelId", "",
                    "imageUnderstandingModel", "", "imageUnderstandingModelChannelId", ""));

            LoopraConfig saved = LoopraConfig.load();
            assertEquals("", saved.validationModel());
            assertEquals("", saved.validationModelChannelId());
            assertEquals("", saved.imageUnderstandingModel());
            assertEquals("", saved.imageUnderstandingModelChannelId());
        } finally {
            System.setProperty("user.home", originalUserHome);
        }
    }

    private static LoopraConfig config(String json) throws Exception {
        Constructor<LoopraConfig> constructor = LoopraConfig.class.getDeclaredConstructor(ONode.class);
        constructor.setAccessible(true);
        return constructor.newInstance(ONode.ofJson(json));
    }
}

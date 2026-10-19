package site.sorghum.loopra.integration.cutin;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.tool.Tool;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.cutin.core.tool.ToolDefinition;
import site.sorghum.cutin.core.tool.ToolResult;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.solon.mcp.McpFunctionTool;

import java.lang.reflect.Type;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ToolRegistryCutinSyncTest {

    @Test
    void mcpFailureRemainsFailureAcrossCutinBridge() {
        FunctionTool delegate = new org.noear.solon.ai.chat.tool.FunctionToolDesc("mcp_fail")
                .inputSchema("{\"type\":\"object\"}").doHandle(args -> {
                    var result = org.noear.solon.ai.chat.tool.ToolResult.success("remote failure");
                    result.setError(true);
                    return result;
                });
        ToolResult result = new CutinFunctionToolBridge(new McpFunctionTool(delegate)).call(
                new ToolCall("failed-call", "mcp_fail", Map.of(), null), null);
        assertFalse(result.ok());
        assertEquals("remote failure", result.error());
    }

    @Test
    void registryChangesPropagateToCutinView() {
        ToolRegistry registry = new ToolRegistry();
        FunctionTool tool = simpleTool("ping");
        registry.register(tool);

        assertTrue(registry.cutinRegistry().find("ping").isPresent());

        registry.setForceDenyTools(Set.of("ping"));
        assertFalse(
            registry.cutinRegistry().find("ping").isPresent(),
            "force-deny must remove the tool from the cutin view"
        );
    }

    @Test
    void functionToolMetadataIsBridgedIntoCutinDefinition() {
        ToolRegistry registry = new ToolRegistry();
        FunctionTool tool = simpleTool("write_file");
        Map<String, Object> meta = tool.meta();
        meta.put("readOnly", false);
        meta.put("stormExempt", true);
        meta.put("timeoutMillis", 12345L);
        meta.put("roles", List.of("implement"));
        registry.register(tool);

        ToolDefinition definition = registry.cutinRegistry().find("write_file")
            .orElseThrow().definition();
        assertFalse(definition.metadata().readOnly());
        assertTrue(definition.metadata().stormExempt());
        assertEquals(12345L, definition.metadata().timeoutMillis());
        assertTrue(definition.metadata().roles().contains("implement"));
    }

    @Test
    void modelVisibleSchemasExcludeRuntimeInjectedArguments() {
        ToolRegistry registry = new ToolRegistry();
        registry.register(simpleTool("runtime_context_tool", """
            {
              "type": "object",
              "properties": {
                "path": {"type": "string"},
                "ctx": {"type": "object", "properties": {"large": {"type": "object"}}},
                "__cwd": {"type": "string"}
              },
              "required": ["path", "ctx", "__cwd"]
            }
            """));

        ONode openAiSchema = registry.toOpenAiTools()
            .get(0).get("function").get("parameters");
        Map<?, ?> openAiProperties = openAiSchema.get("properties").toBean(Map.class);
        assertEquals(Set.of("path"), openAiProperties.keySet());
        assertEquals(List.of("path"), openAiSchema.get("required").toBean(List.class));

        Map<String, Object> cutinSchema = registry.cutinRegistry()
            .find("runtime_context_tool").orElseThrow().definition().inputSchema();
        assertEquals(Set.of("path"), ((Map<?, ?>) cutinSchema.get("properties")).keySet());
        assertEquals(List.of("path"), cutinSchema.get("required"));
    }

    @Test
    void mcpBridgeDoesNotForwardLoopraRuntimeContext() {
        java.util.concurrent.atomic.AtomicReference<Map<String, Object>> captured =
                new java.util.concurrent.atomic.AtomicReference<>();
        FunctionTool delegate = new org.noear.solon.ai.chat.tool.FunctionToolDesc("resolve-library-id")
                .description("Resolve a library id.")
                .inputSchema("{\"type\":\"object\",\"properties\":{\"libraryName\":{\"type\":\"string\"}}}")
                .returnType(String.class)
                .doHandle(args -> {
                    captured.set(new LinkedHashMap<>(args));
                    return "ok";
                });
        Map<String, Object> runtimeContext = new LinkedHashMap<>();
        runtimeContext.put("ctx", new Object());
        runtimeContext.put("__cwd", "C:/project");
        CutinFunctionToolBridge.setCallContext(runtimeContext);
        try {
            ToolResult result = new CutinFunctionToolBridge(new McpFunctionTool(delegate)).call(
                    new ToolCall("call-1", "resolve-library-id", Map.of("libraryName", "Solon"), null), null);

            assertEquals("ok", result.content());
            assertEquals(Map.of("libraryName", "Solon"), captured.get());
        } finally {
            CutinFunctionToolBridge.clearCallContext();
        }
    }

    @Test
    void clearToolsEmptiesLegacyAndCutinView() {
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));

        assertTrue(registry.cutinRegistry().find("ping").isPresent());
        assertFalse(registry.all().isEmpty());

        registry.clearTools();

        assertTrue(registry.all().isEmpty(), "legacy enabled map must be empty");
        assertTrue(registry.allScanned().isEmpty(), "scanned map must be empty");
        assertFalse(registry.cutinRegistry().find("ping").isPresent(), "cutin view must be empty");
        assertEquals(0, registry.toOpenAiTools().getArray().size(), "no tools to upload");
    }

    @Test
    void syncReplacementBreaksRegistrationCloseButClearToolsStillEmptiesView() {
        // 复现“禁用 tool-gateway 后工具仍上传”的根因：
        // gateway 注册时闭包捕获当时的 bridge 实例；refresh() 的 syncCutinRegistry 会
        // setTools 换成新 bridge 实例，导致 stop 时 unregister(旧实例) 实例不匹配而移除失败。
        // 双区视图后 gateway 的 bridge 进外部注册区、不再被 setTools 替换，因此 stop 可正常
        // 注销自己的实例；legacy 侧旧实例注销失败仍有 clearTools 整体清空兜底。
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));
        Tool bridgeAtRegister = registry.cutinRegistry().find("ping").orElseThrow();

        registry.refresh(); // 走“已注入”分支 → syncCutinRegistry → 视图换成新 bridge 实例
        Tool current = registry.cutinRegistry().find("ping").orElseThrow();
        assertNotSame(bridgeAtRegister, current, "sync 必须把视图换成新 bridge 实例");

        // 旧实例（注册时捕获）注销必然失败——网关 stop 无法移除 legacy 同步区的桥接
        boolean removed = registry.cutinRegistry().unregister("ping", bridgeAtRegister);
        assertFalse(removed, "旧实例注销必然失败——网关 stop 无法移除 legacy 同步区的桥接");

        // 兜底：clearTools 整体清空，模型请求的 tools 为空
        registry.clearTools();
        assertFalse(registry.cutinRegistry().find("ping").isPresent());
        assertEquals(0, registry.toOpenAiTools().getArray().size());
    }

    @Test
    void externalReregisterReplacesSameIdInstance() {
        // 复现“插件热重启后工具定义过期”场景：gateway stop→start 时
        // DefaultLoopRegistrar 会把旧实例恢复进外部区；start 重新注册的新实例
        // 必须覆盖旧实例，否则视图一直执行过期定义。
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));

        Tool first = simpleCutinTool("ping");
        registry.cutinRegistry().register(first);
        assertSame(first, registry.cutinRegistry().find("ping").orElseThrow());

        // 热重启：外部区已有旧实例，新实例同 id 重新注册必须生效
        Tool second = simpleCutinTool("ping");
        registry.cutinRegistry().register(second);
        assertSame(second, registry.cutinRegistry().find("ping").orElseThrow(),
            "重复注册同 id 必须以最新实例为准");

        // 旧实例注销应失败（已被新实例替换），新实例注销成功
        assertFalse(registry.cutinRegistry().unregister("ping", first));
        assertTrue(registry.cutinRegistry().unregister("ping", second));
        assertFalse(registry.cutinRegistry().find("ping").isPresent());
    }

    @Test
    void externallyRegisteredToolsSurviveSyncReplacement() {
        // 拓展包/插件贡献的工具经 register 进入外部注册区，loopra 工具表刷新
        // （setTools 全量替换同步区）不得抹掉它们。
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));

        Tool ext = simpleCutinTool("demo-greeting");
        registry.cutinRegistry().register(ext);
        assertTrue(registry.cutinRegistry().find("demo-greeting").isPresent());

        registry.refresh(); // 触发 syncCutinRegistry → setTools 全量替换同步区
        assertTrue(registry.cutinRegistry().find("demo-greeting").isPresent(),
            "loopra 工具表同步不能抹掉外部注册（拓展包）工具");
        assertTrue(registry.cutinRegistry().find("ping").isPresent());

        // 外部注册工具仍可通过 unregister 移除
        assertTrue(registry.cutinRegistry().unregister("demo-greeting", ext));
        assertFalse(registry.cutinRegistry().find("demo-greeting").isPresent());
    }

    @Test
    void externalRegistrationWinsOverSyncOnSameId() {
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));

        Tool ext = simpleCutinTool("ping");
        registry.cutinRegistry().register(ext);
        assertSame(ext, registry.cutinRegistry().find("ping").orElseThrow(),
            "同名冲突时外部注册优先");

        registry.refresh(); // 同步区重建也不覆盖外部注册的同名工具
        assertSame(ext, registry.cutinRegistry().find("ping").orElseThrow());
    }

    @Test
    void clearToolsAlsoClearsExternallyRegisteredTools() {
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));
        registry.cutinRegistry().register(simpleCutinTool("demo-greeting"));

        registry.clearTools();

        assertFalse(registry.cutinRegistry().find("ping").isPresent());
        assertFalse(registry.cutinRegistry().find("demo-greeting").isPresent(),
            "clearTools 应连外部注册工具一起清空");
        assertEquals(0, registry.toOpenAiTools().getArray().size());
    }

    @Test
    void externallyRegisteredToolsAreVisibleToModelAndCacheInvalidates() {
        ToolRegistry registry = new ToolRegistry();
        registry.setEnvironment(SessionEnvironment.local(Paths.get(System.getProperty("user.dir"))));
        registry.register(simpleTool("ping"));

        // 注册前缓存已生成，外部工具注册后必须失效缓存并可见
        assertFalse(hasTool(registry.toOpenAiTools(), "demo-greeting"));
        Tool ext = simpleCutinTool("demo-greeting");
        registry.cutinRegistry().register(ext);

        ONode tools = registry.toOpenAiTools();
        assertTrue(hasTool(tools, "demo-greeting"), "外部工具应出现在模型可见的 tools 数组");
        assertTrue(hasTool(tools, "ping"));
        ONode fn = tools.getArray().stream()
            .filter(n -> "demo-greeting".equals(n.get("function").get("name").getString()))
            .findFirst().orElseThrow().get("function");
        assertEquals("External tool.", fn.get("description").getString());
        assertTrue(fn.get("parameters").isObject());

        // 注销后缓存同样失效，工具从模型可见列表移除
        assertTrue(registry.cutinRegistry().unregister("demo-greeting", ext));
        assertFalse(hasTool(registry.toOpenAiTools(), "demo-greeting"));
    }

    private static boolean hasTool(ONode tools, String name) {
        if (tools == null || !tools.isArray()) {
            return false;
        }
        return tools.getArray().stream()
            .anyMatch(n -> name.equals(n.get("function").get("name").getString()));
    }

    private static Tool simpleCutinTool(String name) {
        return new Tool() {
            @Override
            public String id() {
                return name;
            }

            @Override
            public ToolDefinition definition() {
                return new ToolDefinition(name, "External tool.", Map.of());
            }

            @Override
            public ToolResult call(ToolCall call, LoopContext context) {
                return ToolResult.success(call.id(), "ok");
            }
        };
    }

    private static FunctionTool simpleTool(String name) {
        return simpleTool(name, "{\"type\":\"object\",\"properties\":{}}");
    }

    private static FunctionTool simpleTool(String name, String inputSchema) {
        Map<String, Object> meta = new LinkedHashMap<>();
        return new FunctionTool() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public String title() {
                return name;
            }

            @Override
            public String description() {
                return "Simple test tool.";
            }

            @Override
            public boolean returnDirect() {
                return false;
            }

            @Override
            public String inputSchema() {
                return inputSchema;
            }

            @Override
            public Type returnType() {
                return String.class;
            }

            @Override
            public Object handle(Map<String, Object> args) {
                return "pong";
            }

            @Override
            public Map<String, Object> meta() {
                return meta;
            }

            @Override
            public void metaPut(String key, Object value) {
                meta.put(key, value);
            }
        };
    }
}

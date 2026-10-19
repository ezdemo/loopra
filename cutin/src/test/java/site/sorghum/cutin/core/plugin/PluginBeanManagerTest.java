package site.sorghum.cutin.core.plugin;

import org.junit.jupiter.api.Test;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;

import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 插件 Bean 管理器测试：验证插件注册、Bean 注入与启动流程。
 */
class PluginBeanManagerTest {

    /** 插件应能通过 Bean 管理器注册并启动，效果在循环中可见。 */
    @Test
    void pluginIsRegisteredAndStartedWithoutYaml() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());

        manager.registerBean("greeting", "hello");
        manager.registerPlugin(StatePlugin.class);
        manager.startAll();

        LoopProgram program = LoopProgram.builder("plugin")
            .node("finish", NodeType.CODE, Steps.finish())
            .build();

        LoopHandle handle = engine.run(program, Map.of());
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue(result.finalSnapshot().variables().containsKey("pluginApplied"));
        assertEquals("hello", manager.getBean("greeting"));
    }

    @Test
    void pluginCanBeStoppedAndRestartedWithoutDuplicateInterceptors() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        CountingPlugin plugin = new CountingPlugin();
        manager.registerPlugin(plugin);
        manager.startAll();

        LoopProgram program = LoopProgram.builder("lifecycle")
            .node("finish", NodeType.CODE, Steps.finish())
            .build();
        run(engine, program, "first");
        assertEquals(1, plugin.invocations.get());

        manager.stopPlugin(plugin.id());
        LoopResult stopped = run(engine, program, "stopped");
        assertFalse(stopped.finalSnapshot().variables().containsKey("counted"));
        assertEquals(1, plugin.invocations.get());

        manager.startPlugin(plugin.id());
        run(engine, program, "restarted");
        assertEquals(2, plugin.invocations.get());
    }

    private static LoopResult run(DefaultLoopEngine engine, LoopProgram program, String id) throws Exception {
        return engine.run(program, Map.of("id", id)).result().get(5, TimeUnit.SECONDS);
    }
    /** 测试用状态插件：在 BEFORE_STEP 中写入变量。 */
    static class CountingPlugin implements LoopPlugin {
        private final AtomicInteger invocations = new AtomicInteger();

        @Override
        public String id() { return "counting-plugin"; }

        @Override
        public void register(LoopRegistrar registrar) {
            registrar.registerInterceptor(InterceptPoint.BEFORE_STEP, 300, context -> {
                invocations.incrementAndGet();
                context.context().putVariable("counted", true);
                return InterceptDecision.pass();
            });
        }
    }
    static class StatePlugin implements LoopPlugin {

        @Override
        public String id() {
            return "state-plugin";
        }

        @Override
        public void register(LoopRegistrar registrar) {
            registrar.addInterceptor(InterceptPoint.BEFORE_STEP, 300, context -> {
                context.context().putVariable("pluginApplied", true);
                return InterceptDecision.pass();
            });
        }
    }

}

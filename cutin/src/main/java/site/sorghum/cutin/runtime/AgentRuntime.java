package site.sorghum.cutin.runtime;

import site.sorghum.cutin.core.context.Budget;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Agent 运行时：在循环引擎之上提供会话级的高层入口。
 *
 * <p>负责创建会话、把用户输入转换为初始上下文、按会话生成程序并执行；
 * 默认程序是一个“流式模型 → 输出”的最简 Agent 循环。</p>
 */
public final class AgentRuntime {

    /** 底层循环引擎。 */
    private final DefaultLoopEngine engine;
    /** 根据会话生成程序的工厂。 */
    private final AgentProgramFactory programFactory;

    /** 使用默认的最简 Agent 程序创建运行时。 */
    public AgentRuntime(DefaultLoopEngine engine) {
        this(engine, ignored -> LoopProgram.builder("agent")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("default-model"))
            .node("output", NodeType.OUTPUT, Steps.finish())
            .build());
    }

    /** 使用自定义程序工厂创建运行时。 */
    public AgentRuntime(DefaultLoopEngine engine, AgentProgramFactory programFactory) {
        this.engine = engine;
        this.programFactory = programFactory;
    }

    /** 创建一个新会话。 */
    public AgentSession newSession() {
        String id = UUID.randomUUID().toString();
        return new AgentSession(id, this);
    }

    /**
     * 在会话上执行一轮输入。
     *
     * <p>把用户输入追加到会话历史并作为新上下文的消息，完成后仅当循环
     * 正常结束时把结果同步回会话，避免失败轮次污染历史。</p>
     */
    public CompletableFuture<LoopResult> run(AgentSession session, String input) {
        List<Message> messages = new ArrayList<>(session.messages());
        messages.add(new Message("user", input));

        Map<String, Object> variables = Map.of(
            "input", input,
            "sessionId", session.id()
        );
        DefaultLoopContext context = engine.newContext(
            UUID.randomUUID().toString(),
            messages,
            variables,
            Budget.unlimited()
        );
        LoopProgram program = programFactory.create(session);
        LoopHandle handle = engine.run(program, context);
        return handle.result().thenApply(result -> {
            if (result.status() == LoopResult.Status.COMPLETED) {
                session.append(result);
            }
            return result;
        });
    }

    /** 获取底层循环引擎。 */
    public DefaultLoopEngine engine() {
        return engine;
    }
}

package site.sorghum.loopra.web.service;

import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.command.ChatCommandRegistry;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.session.SessionStore.SessionModelSettings;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer.ToolSystem;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.Objects;
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.function.Supplier;

/** 创建已绑定会话的 Agent；缓存、互斥和模型设置解析由调用方负责。 */
final class SessionAgentFactory {

    private final Supplier<ChatCommandRegistry> commands;
    private final BiFunction<String, String, SessionEnvironment> environments;
    private final Function<SessionEnvironment, ToolSystem> toolSystems;

    SessionAgentFactory(Supplier<ChatCommandRegistry> commands,
                        BiFunction<String, String, SessionEnvironment> environments,
                        Function<SessionEnvironment, ToolSystem> toolSystems) {
        this.commands = Objects.requireNonNull(commands, "commands");
        this.environments = Objects.requireNonNull(environments, "environments");
        this.toolSystems = Objects.requireNonNull(toolSystems, "toolSystems");
    }

    LoopraAgent create(String workspacePath, String sessionName, SessionModelSettings settings,
                      String systemPrompt, LoopraConfig config) {
        LoopraConfig.ModelChannel channel = config.modelChannel(settings.modelChannelId());
        if (channel == null) throw new ServiceException("模型渠道不存在: " + settings.modelChannelId());

        LoopraModelProvider provider = new LoopraModelProvider(channel.apiUrl(), channel.apiKey(),
                settings.model(), settings.reasoningEffort(), channel.id(), channel.apiProtocol(),
                channel.specialCompatibility(), config.modelMaxTokens(channel.id(), settings.model()));
        provider.setFastMode(config.fastMode());

        SessionEnvironment environment = environments.apply(workspacePath, sessionName);
        LoopraAgent.Builder builder = LoopraAgent.builder()
                .config(config)
                .environment(environment)
                .commandRegistry(commands.get())
                .hitl(config.hitl())
                .toolSystem(toolSystems.apply(environment))
                .modelProvider(provider);
        if (systemPrompt != null && !systemPrompt.isBlank()) builder.systemPrompt(systemPrompt);

        LoopraAgent agent = builder.buildLightweight();
        try {
            agent.bindSession(sessionName);
            agent.setListener(new WebUsageListener(agent));
            agent.setOutput(AgentOutput.NOOP);
            return agent;
        } catch (RuntimeException exception) {
            agent.dispose();
            throw exception;
        }
    }
}

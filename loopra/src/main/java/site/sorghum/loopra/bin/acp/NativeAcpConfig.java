package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.session.SessionStore;
import java.util.*;

/** Native engine configuration expressed exclusively in standard ACP selectors. */
public final class NativeAcpConfig {
    private NativeAcpConfig() {}
    public static List<SessionConfigOption> options(LoopraConfig config, SessionStore.SessionModelSettings settings,
                                                   Map<String, String> values, boolean plan) {
        if (config == null) return List.of();
        List<SessionConfigSelectOption> models = new ArrayList<>();
        for (var channel : config.modelChannels()) for (String model : channel.models()) {
            models.add(new SessionConfigSelectOption(modelValue(channel.id(), model), channel.name() + " / " + model));
        }
        List<SessionConfigOption> options = new ArrayList<>();
        if (!models.isEmpty()) options.add(select("model", "模型", "model",
                modelValue(settings.modelChannelId(), settings.model()), models));
        options.add(select("mode", "权限模式", "mode", values.getOrDefault("mode", config.hitl()), List.of(
                new SessionConfigSelectOption("approval", "按需审批", "需要授权的工具操作由用户审批", null),
                new SessionConfigSelectOption("auto", "自动审批", "使用 Loopra 的自动审批策略", null),
                new SessionConfigSelectOption("free", "完全自动", "不进行工具权限审批", null))));
        options.add(select("effort", "思考强度", "thought_level", settings.reasoningEffort(),
                List.of("none", "minimal", "low", "medium", "high", "xhigh", "max").stream()
                        .map(value -> new SessionConfigSelectOption(value, value)).toList()));
        options.add(select("fast", "快速模式", "model_config", values.getOrDefault("fast", config.fastMode() ? "on" : "off"), onOff()));
        options.add(select("plan", "计划模式", "_plan", plan ? "on" : "off", onOff()));
        return List.copyOf(options);
    }
    private static List<SessionConfigSelectOption> onOff() {
        return List.of(new SessionConfigSelectOption("off", "关闭"), new SessionConfigSelectOption("on", "开启"));
    }
    private static SessionConfigSelect select(String id, String name, String category, String value, List<SessionConfigSelectOption> options) {
        return new SessionConfigSelect("select", id, name, null, category, value, options, null);
    }
    public static String modelValue(String channel, String model) { return channel + ":" + model; }
    public static void validate(List<SessionConfigOption> options, String id, Object value) {
        for (var option : options) if (option instanceof SessionConfigSelect select && select.id().equals(id)) {
            if (value instanceof String && select.options().stream().anyMatch(item -> item.value().equals(value))) return;
            throw new IllegalArgumentException("无效的配置选项值: " + id);
        }
        throw new IllegalArgumentException("Agent 不支持此配置: " + id);
    }
    public static SessionStore.SessionModelSettings modelSettings(LoopraConfig config, Object value, String effort) {
        for (var channel : config.modelChannels()) for (String model : channel.models()) {
            if (modelValue(channel.id(), model).equals(value)) return new SessionStore.SessionModelSettings(model, channel.id(), effort);
        }
        throw new IllegalArgumentException("模型不可用");
    }
}

package site.sorghum.loopra.web.service;

import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.Objects;
import java.util.function.Function;

/**
 * 负责会话模型设置的读取、合并与持久化。
 *
 * <p>会话设置本身属于会话元数据，不应和 Agent 生命周期或全局配置管理混在一起。
 * AgentService 只负责提供当前会话的路径、缓存候选值和全局默认值。</p>
 */
final class SessionSettingsService {

    private static final SessionStore.SessionModelSettings EMPTY =
            new SessionStore.SessionModelSettings(null, null, null);

    private final Function<String, SessionStore> storeFactory;

    SessionSettingsService(Function<String, SessionStore> storeFactory) {
        this.storeFactory = Objects.requireNonNull(storeFactory, "storeFactory");
    }

    /**
     * 按“请求值 → 会话元数据 → 当前缓存 Agent → 全局默认值”的顺序解析设置。
     * 解析出的结果会回写会话元数据，使旧会话在首次访问后也获得固定设置。
     */
    SessionStore.SessionModelSettings resolve(
            String workspacePath,
            String sessionName,
            SessionStore.SessionModelSettings requested,
            SessionStore.SessionModelSettings cached,
            LoopraConfig config) {
        LoopraConfig.ModelChannel activeChannel = config.activeModelChannel();
        String defaultChannelId = activeChannel != null ? activeChannel.id() : "default";
        SessionStore.SessionModelSettings persisted = read(workspacePath, sessionName);
        SessionStore.SessionModelSettings requestedSettings = requested != null ? requested : EMPTY;
        SessionStore.SessionModelSettings cachedSettings = cached != null ? cached : EMPTY;

        String model = firstNonBlank(
                requestedSettings.model(),
                persisted.model(),
                cachedSettings.model(),
                config.model());
        String channelId = firstNonBlank(
                requestedSettings.modelChannelId(),
                persisted.modelChannelId(),
                cachedSettings.modelChannelId(),
                defaultChannelId);
        boolean channelWasRequested = requestedSettings.modelChannelId() != null
                && !requestedSettings.modelChannelId().isBlank();
        if (config.modelChannel(channelId) == null) {
            if (channelWasRequested) {
                throw new ServiceException("模型渠道不存在: " + channelId);
            }
            channelId = defaultChannelId;
        }

        String reasoningEffort = firstNonBlank(
                requestedSettings.reasoningEffort(),
                persisted.reasoningEffort(),
                cachedSettings.reasoningEffort(),
                config.reasoningEffort(),
                "max");
        SessionStore.SessionModelSettings resolved = new SessionStore.SessionModelSettings(
                model, channelId, reasoningEffort);
        if (!sameSettings(persisted, resolved)) {
            persist(workspacePath, sessionName, resolved);
        }
        return resolved;
    }

    SessionStore.SessionModelSettings read(String workspacePath, String sessionName) {
        SessionStore store = storeFactory.apply(workspacePath);
        if (store == null) return EMPTY;
        try {
            SessionStore.SessionModelSettings settings = store.getModelSettings(sessionName);
            return settings != null ? settings : EMPTY;
        } finally {
            store.shutdown();
        }
    }

    void persist(String workspacePath, String sessionName,
                 SessionStore.SessionModelSettings settings) {
        SessionStore store = storeFactory.apply(workspacePath);
        if (store == null) {
            throw new ServiceException("会话存储不可用");
        }
        try {
            store.setModelSettings(sessionName, settings.model(), settings.modelChannelId(),
                    settings.reasoningEffort());
        } finally {
            store.shutdown();
        }
    }

    private static boolean sameSettings(SessionStore.SessionModelSettings left,
                                        SessionStore.SessionModelSettings right) {
        return Objects.equals(left.model(), right.model())
                && Objects.equals(left.modelChannelId(), right.modelChannelId())
                && Objects.equals(left.reasoningEffort(), right.reasoningEffort());
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return null;
    }
}

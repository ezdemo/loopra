package site.sorghum.loopra.integration.cutin.plugin.state;

/**
 * 状态通知插件依赖的宿主能力。
 * <p>
 * 由 {@code AgentLoop} 实现，插件据此读取「当前会话的易变状态」并把通知写回历史，
 * 而不直接依赖 AgentLoop。
 * </p>
 */
public interface LoopraStateNoticeHost {

    /**
     * 当前需要注入的易变状态正文（Goal 指令 + 计划模式提示）。
     * <p>无状态时返回空串。正文应由宿主自行完成 XML 转义与文案拼装。</p>
     */
    String stateNoticeBody();

    /**
     * 追加一条状态通知到会话历史（模型可见、Web 隐藏、落 JSONL）。
     *
     * @param content 完整通知文本
     * @return 已追加消息的指纹，供调用方比对；失败时返回 {@code null}
     */
    String appendStateNotice(String content);

    /**
     * 就地替换最后一条状态通知的内容（连续两次状态变更且模型尚未产出时使用）。
     *
     * @param content 完整通知文本
     * @return 替换后消息的指纹；不存在可替换的通知时返回 {@code null}
     */
    String replaceLastStateNotice(String content);

    /**
     * 历史中最后一条状态通知的指纹。
     *
     * @return 指纹；历史中没有状态通知时返回 {@code null}
     */
    String lastStateNoticeFingerprint();

    /**
     * 上一条状态通知之后，模型是否已经产出内容。
     * <p>
     * 为 {@code true} 时新状态应当追加而非就地替换 —— 已产出的 assistant 回复
     * 不能被改写，替换会让「通知 → 回复」的因果链错位。
     * </p>
     */
    boolean modelProducedSinceLastNotice();

    /**
     * 是否处于计划模式（用于通知正文渲染）。
     */
    boolean isPlanMode();

    /**
     * 当前循环是否是子代理。
     * <p>
     * 子代理没有 {@code submit_plan}（见 {@code SubAgent.SUB_AGENT_DENY}），
     * 渲染计划模式提示时不能指引它提交计划。
     * </p>
     */
    default boolean isSubAgentLoop() {
        return false;
    }
}

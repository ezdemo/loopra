package site.sorghum.loopra.integration.cutin.plugin.state;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.loopra.bin.agent.prompt.StateNoticeRenderer;

/**
 * 状态通知插件 —— 把易变的会话状态（Goal、计划模式）从 system prompt 搬到历史里。
 * <p>
 * 背景：原先 Goal 指令与计划模式指令拼在 {@code tool-contract} 切片（order 600）里，
 * 状态一变 system 字节就变，整个前缀缓存作废；Goal 指令还每次模型调用都读盘。
 * 现在状态改由「webHidden 的 user 消息」承载：模型照常读到，system 保持逐字节稳定。
 * </p>
 * <p>
 * 幂等策略（不依赖内存账本，重启与会话恢复后同样成立）：
 * <ul>
 *   <li>期望状态指纹 == 历史中最后一条通知的指纹 → 直接放行，零增长零变更</li>
 *   <li>指纹不同且模型尚未产出 → 就地替换最后一条通知</li>
 *   <li>指纹不同且模型已产出 → 追加新通知</li>
 *   <li>期望状态为空而历史里还有通知 → 追加一条「状态已清空」（指纹固定，只发一次）</li>
 *   <li>通知被折叠吞掉 → 下轮扫描不到 → 自动重新注入</li>
 * </ul>
 * </p>
 * <p>
 * 注册在 {@code BEFORE_MODEL} order -250：必须早于折叠插件（-200）——折叠插件会把
 * {@code ConversationContext} 的历史快照整体灌进 cutin 上下文，晚于它就意味着本轮
 * 新写入的通知进不了这次请求，要等到下一步模型才看得见。
 * </p>
 * <p>
 * 选 BEFORE_MODEL 而非「状态变更时主动 push」，是因为主循环、子代理、HITL 恢复、
 * 错误重试全都经过这里，逐个挂钩必然漏。
 * </p>
 */
@Slf4j
@AgentPlugin(id = "loopra-state-notice", order = -150, remark = "把 Goal / 计划模式等易变状态作为系统通知注入历史，保持 system 前缀稳定")
public final class LoopraStateNoticePlugin implements LoopPlugin {

    private final LoopraStateNoticeHost host;

    public LoopraStateNoticePlugin(LoopraStateNoticeHost host) {
        this.host = host;
    }

    @Override
    public String id() {
        return "loopra-state-notice";
    }

    @Override
    public void register(LoopRegistrar registrar) {
        registrar.registerInterceptor(InterceptPoint.BEFORE_MODEL, -250, this::syncStateNotice);
    }

    private InterceptDecision syncStateNotice(InterceptContext context) {
        if (host == null) {
            return InterceptDecision.pass();
        }
        try {
            sync();
        } catch (Exception e) {
            // 状态同步失败不能影响本轮模型调用：system 里的静态约定仍在，模型不会失去约束
            log.warn("[state] 状态通知同步失败: {}", e.getMessage());
        }
        return InterceptDecision.pass();
    }

    /** 幂等同步：按「期望指纹 vs 现存指纹」决定不动作 / 替换 / 追加。包级可见以便单测直接驱动。 */
    void sync() {
        String body = host.stateNoticeBody();
        String expectedFingerprint = body == null || body.isBlank()
                ? StateNoticeRenderer.CLEARED_FINGERPRINT
                : StateNoticeRenderer.fingerprint(body);
        String existingFingerprint = host.lastStateNoticeFingerprint();

        if (existingFingerprint == null) {
            // 历史中没有通知：无状态则什么都不做，有状态才首次注入
            if (StateNoticeRenderer.CLEARED_FINGERPRINT.equals(expectedFingerprint)) {
                return;
            }
            host.appendStateNotice(StateNoticeRenderer.render(body));
            return;
        }
        if (expectedFingerprint.equals(existingFingerprint)) {
            return;
        }
        String rendered = StateNoticeRenderer.CLEARED_FINGERPRINT.equals(expectedFingerprint)
                ? StateNoticeRenderer.renderCleared()
                : StateNoticeRenderer.render(body);
        if (host.modelProducedSinceLastNotice()) {
            host.appendStateNotice(rendered);
        } else if (host.replaceLastStateNotice(rendered) == null) {
            // 无可替换目标（并发折叠等）时退化为追加，保证状态一定送达
            host.appendStateNotice(rendered);
        }
    }
}

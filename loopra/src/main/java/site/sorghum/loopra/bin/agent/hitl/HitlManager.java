package site.sorghum.loopra.bin.agent.hitl;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.model.HitlState;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;

import java.util.Arrays;
import java.util.List;

/**
 * HITL (Human-In-The-Loop) 管理器 —— 负责 HITL 状态管理和用户交互提示。
 * <p>
 * 管理两种 HITL 模式：
 * <ul>
 *   <li><b>普通 HITL</b>（受 {@code hitlMode} 开关控制）：已授权工作区操作放行，其余按需审批</li>
 *   <li><b>沙箱越界 HITL</b>：在两种审批模式下，文件访问越界时需要用户确认</li>
 * </ul>
 * </p>
 *
 * <h3>HITL 模式</h3>
 * <ul>
 *   <li>{@link #MODE_FREE free} — 自由模式，所有工具直接执行，无需审批</li>
 *   <li>{@link #MODE_APPROVAL approval} — 按需审批，普通工作区读写自动放行</li>
 *   <li>{@link #MODE_AUTO auto} — 自动审批，在按需审批规则之后追加 AI 审核</li>
 * </ul>
 *
 * @author Sorghum
 */
@Slf4j
public class HitlManager {

    // ==================== HITL 模式常量 ====================

    /** 自由模式：所有工具直接执行，无需审批 */
    public static final String MODE_FREE = "free";
    /** 按需审批：普通工作区读写自动放行，越界及无法确认范围的操作需审批 */
    public static final String MODE_APPROVAL = "approval";
    /** 自动审批：按需审批规则 + AI 审核，不通过或异常时转人工 */
    public static final String MODE_AUTO = "auto";

    /** 所有模式的列表（用于 toggle 循环） */
    private static final String[] MODES = {MODE_FREE, MODE_APPROVAL, MODE_AUTO};

    // ==================== 普通 HITL 状态 ====================

    /** HITL 模式（free / approval / auto） */
    private volatile String hitlMode = MODE_FREE;

    /** HITL 当前审批状态 */
    private volatile HitlState hitlState = HitlState.NONE;

    /** HITL 暂存的工具调用（ONode 数组） */
    private volatile ONode pendingHITLToolCalls;

    /** HITL 暂存的 assistant content */
    private volatile String pendingHITLContent;

    /** HITL 暂存的 reasoning_content */
    private volatile String pendingHITLReasoning;

    /** HITL 暂存的解析后工具调用列表 */
    @Getter
    private volatile List<ToolCallEntry> pendingHITTcList;

    // ==================== 沙箱越界 HITL（两种审批模式下强制确认） ====================

    /** 沙箱越界 HITL 暂存：完整的工具调用 ONode（供重放） */
    private volatile ONode pendingSandboxHITToolCalls;

    /** 沙箱越界 HITL 暂存：assistant content */
    private volatile String pendingSandboxHITContent;

    /** 沙箱越界 HITL 暂存：reasoning_content */
    private volatile String pendingSandboxHITReasoning;

    /** 沙箱越界 HITL 暂存：越界详情（展示给用户） */
    private volatile String pendingSandboxHITDetails;

    public HitlManager() {
        this(MODE_FREE);
    }

    /**
     * @param hitlMode HITL 模式，接受 "free" / "approval" / "auto"，向后兼容 "true" / "false"
     */
    public HitlManager(String hitlMode) {
        this.hitlMode = normalizeMode(hitlMode);
    }

    /**
     * 将字符串规范化为有效的 HITL 模式（向后兼容 boolean 值）。
     */
    private static String normalizeMode(String mode) {
        if (mode == null) return MODE_FREE;
        return switch (mode.toLowerCase()) {
            case "approval", "approve", "true" -> MODE_APPROVAL;
            case "auto" -> MODE_AUTO;
            default -> MODE_FREE; // 配置为 false / free / 未知时都按自由模式
        };
    }

    // ==================== 基础状态控制 ====================

    /**
     * 切换 HITL 模式：free → approval → auto → free …
     */
    public synchronized void toggleHitl() {
        for (int i = 0; i < MODES.length; i++) {
            if (MODES[i].equals(hitlMode)) {
                hitlMode = MODES[(i + 1) % MODES.length];
                return;
            }
        }
        hitlMode = MODE_FREE; // 兜底
    }

    /**
     * 获取当前 HITL 模式名称。
     */
    public String getHitlMode() {
        return hitlMode;
    }

    /**
     * 设置 HITL 模式。
     *
     * @param mode "free" / "approval" / "auto"，向后兼容 "true"/"false"
     */
    public void setHitlMode(String mode) {
        this.hitlMode = normalizeMode(mode);
    }

    /**
     * 是否启用 HITL 机制（审批模式或自动模式均视为启用）。
     * 自由模式下返回 false。
     */
    public boolean isHitlMode() {
        return MODE_APPROVAL.equals(hitlMode) || MODE_AUTO.equals(hitlMode);
    }

    /** 批准待执行的工具调用 */
    public void approveHITL() {
        hitlState = HitlState.APPROVED;
    }

    /** 拒绝待执行的工具调用 */
    public void denyHITL() {
        hitlState = HitlState.DENIED;
    }

    /** 是否有待审批的工具调用 */
    public boolean hasPendingHITL() {
        return hitlState == HitlState.PENDING;
    }

    /** 获取当前审批状态 */
    public HitlState getState() {
        return hitlState;
    }

    /** 重置审批状态为 NONE */
    public void resetState() {
        hitlState = HitlState.NONE;
    }

    // ==================== 沙箱越界状态查询 ====================

    /** 是否有沙箱越界待审批 */
    public boolean hasSandboxPending() {
        return pendingSandboxHITToolCalls != null;
    }

    /** 暂存沙箱越界的 content/reasoning（AgentLoop 在 executeToolCalls 后调用） */
    public void storeSandboxContent(String content, String reasoningContent) {
        this.pendingSandboxHITContent = content;
        this.pendingSandboxHITReasoning = reasoningContent;
    }

    // ==================== 普通 HITL 拦截 ====================

    /**
     * 兼容旧入口。此方法仅发起人工交互，是否需要人工审批由统一审核链决定。
     */
    public String interceptForHITL(ONode toolCalls, String content, String reasoningContent,
                                   AgentOutput output) {
        return requestApproval(toolCalls, content, reasoningContent, output, null);
    }

    /** 保存待执行批次并展示人工选项，不重新运行审核规则。 */
    public String requestApproval(ONode toolCalls, String content, String reasoningContent,
                                  AgentOutput output, String reviewReason) {
        List<ToolCallEntry> tcList = parseToolCalls(toolCalls);

        // ---- 审批模式：暂存状态，等待用户审批 ----
        this.pendingHITLToolCalls = toolCalls;
        this.pendingHITLContent = content;
        this.pendingHITLReasoning = reasoningContent;
        this.pendingHITTcList = tcList;
        this.hitlState = HitlState.PENDING;

        // 构建 title（工具名）和 description（工具参数）
        StringBuilder titleSb = new StringBuilder();
        StringBuilder descSb = new StringBuilder();
        for (int i = 0; i < tcList.size(); i++) {
            ToolCallEntry tc = tcList.get(i);
            if (i > 0) {
                titleSb.append("、");
                descSb.append("\n");
            }
            titleSb.append(tc.name());
            Object argsObj = tc.arguments();
            String args = argsObj != null ? argsObj.toString() : null;
            if (args != null && !args.isEmpty() && !"{}".equals(args)) {
                String display = args.length() > 200 ? args.substring(0, 200) + "..." : args;
                descSb.append(tc.name()).append(" ").append(display);
            }
        }
        String title = titleSb.toString();
        String description = !descSb.isEmpty() ? descSb.toString() : null;
        if (reviewReason != null && !reviewReason.isBlank()) {
            description = (description == null ? "" : description + "\n\n") + "审核原因: " + reviewReason;
        }

        // 发送审批选项（工具信息通过 title/description 传递，不再发 HITL 文本）
        try {
            output.onChoice(Arrays.asList(
                    new ChoiceOption("/agree", "同意执行"),
                    new ChoiceOption("/deny", "拒绝执行")
            ), title, description);
        } catch (Exception e) {
            log.debug("[hitl] output.onChoice异常(SSE可能已断开): {}", e.getMessage());
        }
        try {
            output.onContentComplete();
        } catch (Exception e) {
            log.debug("[hitl] output.onContentComplete异常(SSE可能已断开): {}", e.getMessage());
        }

        // 构建返回值文本（供 AgentLoop 日志/降级使用，不再通过 SSE 发送）
        StringBuilder sb = new StringBuilder();
        sb.append("⏸️  **HITL 模式：以下工具调用需要审批**\n\n");
        for (ToolCallEntry tc : tcList) {
            String name = tc.name();
            Object argsObj = tc.arguments();
            String args = argsObj != null ? argsObj.toString() : null;
            sb.append("- `").append(name).append("`");
            if (args != null && !args.isEmpty() && !"{}".equals(args)) {
                String display = args.length() > 200 ? args.substring(0, 200) + "..." : args;
                sb.append(" ").append(display);
            }
            sb.append("\n");
        }
        if (reviewReason != null && !reviewReason.isBlank()) {
            sb.append("\n审核原因: ").append(reviewReason).append("\n");
        }
        sb.append("\n请选择：");
        return sb.toString();
    }

    // ==================== 沙箱越界 HITL 拦截 ====================

    /**
     * 沙箱越界 HITL 拦截：向用户展示越界详情，等待审批。
     *
     * @param output 输出接口（用于发送审批提示）
     * @return 审批提示文本
     */
    public String interceptForSandboxHITL(AgentOutput output) {
        String details = this.pendingSandboxHITDetails != null
                ? this.pendingSandboxHITDetails : "未知路径越界";

        String message = "⏸️  **沙箱越界 — 需要审批**\n\n" +
                "检测到工具试图访问项目之外的路径：\n\n" +
                "> " + details + "\n\n" +
                "请选择：";
        try {
            output.onChoice(Arrays.asList(
                    new ChoiceOption("/agree", "同意执行"),
                    new ChoiceOption("/deny", "拒绝执行")
            ), "沙箱越界", details);
        } catch (Exception e) {
            log.debug("[sandbox-hitl] output.onChoice异常: {}", e.getMessage());
        }
        try {
            output.onContentComplete();
        } catch (Exception e) {
            log.debug("[sandbox-hitl] output.onContentComplete异常(SSE可能已断开): {}", e.getMessage());
        }
        return message;
    }

    // ==================== 状态读取（供 AgentLoop resume 方法使用） ====================

    /**
     * 获取并清除普通 HITL 暂存状态。
     * 返回的快照包含所有暂存数据，状态被清空以避免重复使用。
     */
    public PendingHITLState drainPendingHITL() {
        PendingHITLState state = new PendingHITLState(
                this.pendingHITLToolCalls,
                this.pendingHITLContent,
                this.pendingHITLReasoning,
                this.pendingHITTcList
        );
        this.pendingHITLToolCalls = null;
        this.pendingHITLContent = null;
        this.pendingHITLReasoning = null;
        this.pendingHITTcList = null;
        return state;
    }

    /**
     * 获取并清除沙箱越界 HITL 暂存状态。
     * 返回的快照包含所有沙箱暂存数据，状态被清空。
     */
    public PendingSandboxState drainSandboxHITL() {
        PendingSandboxState state = new PendingSandboxState(
                this.pendingSandboxHITToolCalls,
                this.pendingSandboxHITContent,
                this.pendingSandboxHITReasoning,
                this.pendingSandboxHITDetails
        );
        this.pendingSandboxHITToolCalls = null;
        this.pendingSandboxHITContent = null;
        this.pendingSandboxHITReasoning = null;
        this.pendingSandboxHITDetails = null;
        return state;
    }

    /**
     * 设置沙箱越界暂存（由 ToolExecutionResult 处理时调用）。
     *
     * @param toolCalls 触发越界的工具调用
     * @param details   越界详情
     */
    public void setSandboxPending(ONode toolCalls, String details) {
        this.pendingSandboxHITToolCalls = toolCalls;
        this.pendingSandboxHITDetails = details;
        this.hitlState = HitlState.PENDING;
    }

    // ==================== 内部方法 ====================

    /**
     * 解析 ONode 工具调用为 ToolCallEntry 列表。
     */
    private static List<ToolCallEntry> parseToolCalls(ONode toolCalls) {
        return ToolCallEntry.fromToolCalls(toolCalls);
    }

    // ==================== 内部数据类 ====================

    /** 普通 HITL 暂存状态的快照 */
    public record PendingHITLState(ONode toolCalls, String content,
                                   String reasoningContent, List<ToolCallEntry> tcList) {
    }

    /** 沙箱越界 HITL 暂存状态的快照 */
    public record PendingSandboxState(ONode toolCalls, String content,
                                      String reasoningContent, String details) {
    }
}

package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Destroy;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.requirement.Requirement;
import site.sorghum.loopra.bin.requirement.RequirementStore;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Web 层需求池管理器 —— 需求存储 + AI 执行器。
 * <p>
 * 执行模型（docs/requirement-board-ai-design.md §4）：
 * <ul>
 *   <li>守护 ticker（15s）扫描 todo 需求自动执行；前端「让 AI 执行」按钮走 {@link #run}</li>
 *   <li>全局并发上限 2；每需求独立会话 {@code req_<id>}（workspace = project.path）</li>
 *   <li>状态流转由 AI 通过 finish_requirement 工具声明（{@link #finish}），执行器只兜底（异常 → failed）</li>
 *   <li>评论 = 排队中的 user 消息（写入会话，Agent 上下文天然可见）；AI 用 reply_requirement_comment 回复</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class RequirementManager {

    /** 全局同时执行上限 */
    private static final int CONCURRENCY = 2;
    /** 守护 ticker 间隔（秒） */
    private static final int TICKER_INTERVAL_SEC = 15;

    @Inject
    private AgentService agentService;

    private RequirementStore store;
    private final ExecutorService executor = Executors.newFixedThreadPool(CONCURRENCY, runnable -> {
        Thread thread = new Thread(runnable, "requirement-executor");
        thread.setDaemon(true);
        return thread;
    });
    private final ScheduledExecutorService ticker = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "requirement-ticker");
        thread.setDaemon(true);
        return thread;
    });
    /** 正在执行的需求 ID 集合（幂等 + 并发上限判定） */
    private final Set<String> runningIds = ConcurrentHashMap.newKeySet();

    @Init
    public void init() {
        this.store = new RequirementStore();
        ticker.scheduleAtFixedRate(this::scanAndRun, TICKER_INTERVAL_SEC, TICKER_INTERVAL_SEC, TimeUnit.SECONDS);
        log.info("[requirement] 需求池存储与执行器初始化完成（并发上限 {}，ticker {}s）", CONCURRENCY, TICKER_INTERVAL_SEC);
    }

    @Destroy
    public void destroy() {
        ticker.shutdownNow();
        executor.shutdownNow();
        log.info("[requirement] 需求池执行器已关闭");
    }

    /**
     * Solon 容器默认构造（@Init 初始化 store 与 ticker）。
     */
    public RequirementManager() {
    }

    /**
     * 可注入构造（测试 / 自定义装配场景，不启动 ticker 与执行线程）。
     */
    public RequirementManager(RequirementStore store, AgentService agentService) {
        this.store = store;
        this.agentService = agentService;
    }

    // ==================== 需求增删改查 ====================

    /**
     * 列出全部需求（保持创建顺序）。
     */
    public List<Requirement> list() {
        return store.loadAll();
    }

    /**
     * 创建需求（调用方需保证 title/projectHash 已校验）。
     */
    public Requirement create(Requirement draft) {
        long now = System.currentTimeMillis();
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        Requirement requirement = Requirement.builder()
                .id(id)
                .title(draft.getTitle().trim())
                .description(draft.getDescription() == null ? "" : draft.getDescription().trim())
                .priority(draft.getPriority() == null || draft.getPriority().isBlank() ? "medium" : draft.getPriority())
                .projectHash(draft.getProjectHash())
                .projectName(draft.getProjectName())
                .status("todo")
                .scheduleMode("scheduled".equals(draft.getScheduleMode()) ? "scheduled" : "immediate")
                .scheduledAt("scheduled".equals(draft.getScheduleMode()) ? draft.getScheduledAt() : 0)
                .model(blankToNull(draft.getModel()))
                .modelChannelId(blankToNull(draft.getModelChannelId()))
                .reasoningEffort(blankToNull(draft.getReasoningEffort()))
                .hitl(blankToNull(draft.getHitl()))
                .summary("")
                .sessionName("req_" + id)
                .createdAt(now)
                .updatedAt(now)
                .build();
        store.upsert(requirement);
        return requirement;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    /**
     * 更新需求描述/优先级（标题与状态不可改）。
     *
     * @return 更新后的需求，不存在返回 null
     */
    public Requirement update(String id, Requirement update) {
        Requirement existing = store.get(id);
        if (existing == null) {
            return null;
        }
        if (update.getDescription() != null) {
            existing.setDescription(update.getDescription().trim());
        }
        if (update.getPriority() != null && !update.getPriority().isBlank()) {
            existing.setPriority(update.getPriority());
        }
        existing.setUpdatedAt(System.currentTimeMillis());
        store.upsert(existing);
        return existing;
    }

    /**
     * 删除需求（不级联删除其执行会话）。
     */
    public boolean delete(String id) {
        return store.remove(id);
    }

    // ==================== 评论与消息 ====================

    /**
     * 追加评论：作为普通 user 消息写入需求专属会话（Agent 上下文可见，Web 历史也可见）。
     * <p>已完成/已失败的需求收到评论时，异步触发一次 AI 回复回合（不动状态）。</p>
     */
    public boolean addComment(String id, String text) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return false;
        }
        String workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
        if (workspacePath == null) {
            log.warn("[requirement] 评论失败：需求 {} 所属项目不存在: {}", id, requirement.getProjectHash());
            return false;
        }
        agentService.appendUserMessage(workspacePath, requirement.getSessionName(), text);
        requirement.setUpdatedAt(System.currentTimeMillis());
        store.upsert(requirement);

        // 执行已结束（done/failed）的需求：评论触发一次 AI 回复回合
        String status = requirement.getStatus();
        if ("done".equals(status) || "failed".equals(status)) {
            String requirementId = requirement.getId();
            executor.submit(() -> replyToComment(requirementId));
        }
        return true;
    }

    /**
     * 回复回合：驱动需求会话的 Agent 回复最新评论（webHidden 指令消息，不流转状态）。
     * <p>评论本身已通过 appendUserMessage 进入 Agent 上下文，此回合只是让 AI 开口。</p>
     */
    private void replyToComment(String id) {
        try {
            Requirement requirement = store.get(id);
            if (requirement == null) {
                return;
            }
            String workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
            if (workspacePath == null) {
                return;
            }
            agentService.executeRequirement(workspacePath, requirement.getSessionName(),
                    buildSystemPrompt(requirement),
                    "用户发表了新评论，请阅读并回复（可直接回复，或用 reply_requirement_comment 工具）。", true,
                    requirement.getModel(), requirement.getModelChannelId(), requirement.getReasoningEffort(), requirement.getHitl());
        } catch (Exception e) {
            log.warn("[requirement] 评论回复回合失败: {}", e.getMessage());
        }
    }

    /**
     * AI 回复用户评论：以 assistant 消息写入需求会话（评论 tab 可见）。
     */
    public boolean replyComment(String id, String reply) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return false;
        }
        String workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
        if (workspacePath == null) {
            return false;
        }
        agentService.appendAssistantMessage(workspacePath, requirement.getSessionName(), reply);
        return true;
    }

    /**
     * 拉取需求专属会话的消息流（= 评论 + 执行日志的数据源）。
     *
     * @return 会话消息列表；需求不存在返回 null
     */
    public List<ChatMessage> getMessages(String id) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return null;
        }
        String workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
        if (workspacePath == null) {
            return new ArrayList<>();
        }
        return agentService.getHistory(workspacePath, requirement.getSessionName());
    }

    /**
     * 需求上下文摘要（供 show_requirements 工具使用）：需求详情 + 最近 20 条评论。
     *
     * @return 文本摘要；需求不存在返回 REQUIRMENT_NOT_FOUND
     */
    public String requirementContextForAI(String id) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return "REQUIREMENT_NOT_FOUND: 需求不存在: " + id;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("标题: ").append(requirement.getTitle())
                .append("\n状态: ").append(requirement.getStatus())
                .append("\n优先级: ").append(requirement.getPriority())
                .append("\n项目: ").append(requirement.getProjectName())
                .append("\n描述: ").append(requirement.getDescription());
        String workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
        if (workspacePath != null) {
            List<String> comments = new ArrayList<>();
            for (ChatMessage message : agentService.getHistory(workspacePath, requirement.getSessionName())) {
                if (message.isUser() && message.getContent() != null && !message.getContent().isBlank()) {
                    comments.add(message.getContent());
                    if (comments.size() >= 20) break;
                }
            }
            if (!comments.isEmpty()) {
                sb.append("\n\n最近评论：\n");
                for (int i = 0; i < comments.size(); i++) {
                    sb.append(i + 1).append(". ").append(comments.get(i)).append('\n');
                }
            }
        }
        return sb.toString();
    }

    // ==================== AI 执行器 ====================

    /**
     * 手动触发执行：todo/failed → doing 并入队（并发上限 2）。
     *
     * @return started=已入队；busy=已在执行中或状态不允许；not_found=需求不存在
     */
    public String run(String id) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return "not_found";
        }
        String status = requirement.getStatus();
        if (!"todo".equals(status) && !"failed".equals(status)) {
            return "busy";
        }
        if (!runningIds.add(id)) {
            return "busy";
        }
        requirement.setStatus("doing");
        requirement.setApprovalPending(false);
        requirement.setUpdatedAt(System.currentTimeMillis());
        store.upsert(requirement);
        log.info("[requirement] 需求开始执行: {} ({})", requirement.getTitle(), id);
        executor.submit(() -> executeRequirement(id));
        return "started";
    }

    /**
     * 对审批模式下暂存的工具调用作出决定，并在原需求会话继续执行。
     */
    public boolean resolveApproval(String id, boolean approved) {
        Requirement requirement = store.get(id);
        if (requirement == null || !"doing".equals(requirement.getStatus()) || !requirement.isApprovalPending()) {
            return false;
        }
        if (!runningIds.add(id)) {
            return false;
        }
        requirement.setApprovalPending(false);
        requirement.setUpdatedAt(System.currentTimeMillis());
        store.upsert(requirement);
        executor.submit(() -> resumeRequirement(id, approved));
        return true;
    }

    /**
     * 人工取消执行：中断会话并将状态回退到 todo（可重新执行）。
     */
    public boolean abort(String id) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return false;
        }
        if ("doing".equals(requirement.getStatus())) {
            String workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
            if (workspacePath != null) {
                try {
                    agentService.abortChat(workspacePath, requirement.getSessionName());
                } catch (Exception e) {
                    log.warn("[requirement] 中断会话失败: {}", e.getMessage());
                }
            }
            requirement.setStatus("todo");
            requirement.setApprovalPending(false);
            requirement.setUpdatedAt(System.currentTimeMillis());
            store.upsert(requirement);
            log.info("[requirement] 需求已人工取消: {}", id);
        }
        return true;
    }

    /**
     * AI 流转状态（finish_requirement 工具回调）：done/failed + 完成总结。
     */
    public void finish(String id, String status, String summary) {
        Requirement requirement = store.get(id);
        if (requirement == null) {
            return;
        }
        requirement.setStatus("done".equals(status) ? "done" : "failed");
        requirement.setApprovalPending(false);
        requirement.setSummary(summary != null ? summary : "");
        requirement.setUpdatedAt(System.currentTimeMillis());
        store.upsert(requirement);
        log.info("[requirement] AI 声明需求结果: {} → {} ({})", requirement.getTitle(), requirement.getStatus(), id);
    }

    /**
     * 守护 ticker：自动拉起立即执行，或已到执行时间的定时需求。
     */
    void scanAndRun() {
        long now = System.currentTimeMillis();
        for (Requirement requirement : store.loadAll()) {
            if ("todo".equals(requirement.getStatus())
                    && !runningIds.contains(requirement.getId())
                    && isDue(requirement, now)) {
                run(requirement.getId());
            }
        }
    }

    private boolean isDue(Requirement requirement, long now) {
        return !"scheduled".equals(requirement.getScheduleMode())
                || requirement.getScheduledAt() <= now;
    }

    /**
     * 异步执行体：SystemPrompt 注入 → Agent 无头执行 → 状态兜底。
     * <p>
     * AI 通过 finish_requirement 正常流转；chat 异常 → failed；
     * chat 正常返回但未声明 → 按完成处理（记录提示）。
     * </p>
     */
    private void executeRequirement(String id) {
        runRequirement(id, (workspacePath, requirement) -> {
            agentService.executeRequirement(workspacePath, requirement.getSessionName(),
                    buildSystemPrompt(requirement),
                    "请执行需求。执行期间用户评论会作为消息进入本会话，可回复；完成后必须调用 finish_requirement 声明结果。", true,
                    requirement.getModel(), requirement.getModelChannelId(), requirement.getReasoningEffort(), requirement.getHitl());
        }, "需求执行异常", "执行异常: ");
    }

    private void resumeRequirement(String id, boolean approved) {
        runRequirement(id, (workspacePath, requirement) ->
                agentService.resolveRequirementApproval(workspacePath, requirement.getSessionName(), approved),
                "审批后恢复执行异常", "审批后执行异常: ");
    }

    private void runRequirement(String id, java.util.function.BiConsumer<String, Requirement> action,
                                String errorLabel, String errorSummary) {
        String workspacePath = null;
        try {
            Requirement requirement = store.get(id);
            if (requirement == null) {
                return;
            }
            workspacePath = agentService.resolveProjectPath(requirement.getProjectHash());
            if (workspacePath == null) {
                throw new IllegalStateException("需求所属项目不存在: " + requirement.getProjectHash());
            }
            action.accept(workspacePath, requirement);

            if (agentService.hasPendingRequirementApproval(workspacePath, requirement.getSessionName())) {
                requirement.setApprovalPending(true);
                requirement.setUpdatedAt(System.currentTimeMillis());
                store.upsert(requirement);
                return;
            }

            // chat 正常返回但 AI 未显式声明结果 → 按完成处理
            Requirement current = store.get(id);
            if (current != null && "doing".equals(current.getStatus())) {
                current.setStatus("done");
                current.setApprovalPending(false);
                current.setSummary("AI 执行完成（未显式调用 finish_requirement，已按正常完成处理）");
                current.setUpdatedAt(System.currentTimeMillis());
                store.upsert(current);
            }
        } catch (Exception e) {
            log.error("[requirement] {}: {}", errorLabel, e.getMessage());
            Requirement current = store.get(id);
            if (current != null && "doing".equals(current.getStatus())) {
                current.setStatus("failed");
                current.setApprovalPending(false);
                current.setSummary(errorSummary + e.getMessage());
                current.setUpdatedAt(System.currentTimeMillis());
                store.upsert(current);
            }
        } finally {
            runningIds.remove(id);
        }

        // 执行结束（done/failed）→ 在评论区追加一条 AI 结束评论（✅/❌ 前缀，前端据此展示）
        Requirement finalState = store.get(id);
        if (finalState != null && workspacePath != null
                && ("done".equals(finalState.getStatus()) || "failed".equals(finalState.getStatus()))) {
            appendFinishComment(finalState, workspacePath);
        }
    }

    /**
     * 追加 AI 结束评论：把执行结果（状态 + 总结）写入需求会话，展示在评论区。
     * <p>必须在 chat 结束后调用（工具回调内直接写会与回合落库顺序冲突）。</p>
     */
    private void appendFinishComment(Requirement requirement, String workspacePath) {
        String prefix = "done".equals(requirement.getStatus()) ? "✅ 已完成：" : "❌ 已失败：";
        String summary = requirement.getSummary();
        if (summary == null || summary.isBlank()) {
            summary = "（无总结）";
        }
        try {
            agentService.appendAssistantMessage(workspacePath, requirement.getSessionName(), prefix + summary);
            log.info("[requirement] 已写入 AI 结束评论: {} ({})", prefix.trim(), requirement.getId());
        } catch (Exception e) {
            log.warn("[requirement] 写入结束评论失败: {}", e.getMessage());
        }
    }

    /**
     * 需求 SystemPrompt：注入标题/优先级/项目/描述（docs §5）。
     */
    private String buildSystemPrompt(Requirement requirement) {
        return """
                你是需求执行 Agent。当前会话绑定一个需求，请在所属项目中完成它。
                完成后必须调用 finish_requirement 工具声明结果（status 传 done 或 failed，summary 总结所做改动与结果）。
                summary 必须使用简洁 Markdown：先写一句结论，后续多个改动、问题或验证结果使用 `- ` 分行列出，项目之间留空行；不要把多项内容压成一整段。
                执行期间用户评论会作为消息进入本会话，可用 reply_requirement_comment 回复用户评论。

                需求详情：
                - 标题：%s
                - 优先级：%s
                - 项目：%s
                - 描述：%s
                """.formatted(
                requirement.getTitle(),
                requirement.getPriority(),
                requirement.getProjectName(),
                requirement.getDescription());
    }
}

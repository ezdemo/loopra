package site.sorghum.loopra.bin.agent.core;

import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.hitl.HitlManager;
import site.sorghum.loopra.bin.agent.hitl.ReadOnlyShellCommands;
import site.sorghum.loopra.bin.agent.hitl.WorkspaceFileOperations;
import site.sorghum.loopra.bin.agent.hitl.WorkspaceShellCommands;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.tool.ToolMetadata;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * 工具调用的统一审核入口。每一层可终止审核，自动批准的调用从待审集合移除，
 * 只有仍未获批准的调用会进入下一层；整个批次获批准后才执行任何工具。
 */
final class ToolApprovalReviewer {
    enum Verdict { NEXT, APPROVED, HUMAN, SANDBOX }

    record Decision(Verdict verdict, String reviewer, String reason) {
        boolean approved() { return verdict == Verdict.APPROVED; }
    }

    @FunctionalInterface
    private interface Reviewer {
        Decision review(ReviewContext context);
    }

    private record Stage(String name, Reviewer reviewer) { }

    private record ReviewContext(List<ToolCallEntry> pending, String mode, Path workspace) {
        private ReviewContext {
            pending = new ArrayList<>(pending);
        }
    }

    private static final Decision NEXT = new Decision(Verdict.NEXT, "", "");
    private static final Set<String> CONTROL_TOOLS = Set.of("finish", "ask_choice", "browser_request_user_action");
    private static final Set<String> SHELL_TOOLS = Set.of("bash", "bash_start");
    private final AgentLoop loop;
    private final List<Stage> stages;
    private volatile ToolCallValidator aiReviewer;

    ToolApprovalReviewer(AgentLoop loop, ToolCallValidator aiReviewer) {
        this.loop = Objects.requireNonNull(loop);
        this.aiReviewer = Objects.requireNonNull(aiReviewer);
        this.stages = List.of(
                new Stage("boundary", this::reviewBoundary),
                new Stage("mode", this::reviewMode),
                new Stage("read-only", this::reviewReadOnly),
                new Stage("workspace", this::reviewWorkspace),
                new Stage("ai", this::reviewAi),
                new Stage("human", this::reviewHuman));
    }

    void setAiReviewer(ToolCallValidator reviewer) {
        aiReviewer = Objects.requireNonNull(reviewer);
    }

    Decision review(ONode toolCalls) {
        if (HitlManager.MODE_FREE.equals(loop.getHitlMode())) {
            return new Decision(Verdict.APPROVED, "mode", "完全自动模式，跳过审核");
        }
        if (toolCalls == null || !toolCalls.isArray()) {
            return new Decision(Verdict.HUMAN, "input", "工具调用格式无效");
        }
        List<ToolCallEntry> calls = ToolCallEntry.fromToolCalls(toolCalls);
        if (calls.size() != toolCalls.getArray().size()) {
            return new Decision(Verdict.HUMAN, "input", "工具名称为空或格式无效");
        }
        ReviewContext context = new ReviewContext(calls, loop.getHitlMode(), loop.workingDirectory());
        for (Stage stage : stages) {
            Decision decision = stage.reviewer().review(context);
            if (decision.verdict() != Verdict.NEXT) return decision;
            if (context.pending().isEmpty()) {
                return new Decision(Verdict.APPROVED, stage.name(), "自动审核通过");
            }
        }
        throw new IllegalStateException("审核链缺少人工审批兜底");
    }

    /** 两种审批模式都先检查整个批次的边界，不能由 AI 自动放行越界操作。 */
    private Decision reviewBoundary(ReviewContext context) {
        for (ToolCallEntry call : context.pending()) {
            var arguments = ToolCallEntry.parseArguments(call.arguments());
            Object target = arguments.get("file_path");
            boolean outside = WorkspaceFileOperations.isFileWrite(call)
                    && target instanceof String
                    && !WorkspaceFileOperations.isWorkspaceWrite(call, context.workspace());
            if (SHELL_TOOLS.contains(call.name()) && arguments.get("command") instanceof String command) {
                Path directory = context.workspace();
                if (arguments.get("workdir") instanceof String workdir && !workdir.isBlank()) {
                    if (!WorkspaceFileOperations.isWithin(context.workspace(), directory, workdir)) outside = true;
                    else directory = directory.resolve(workdir);
                }
                outside |= WorkspaceShellCommands.hasOutsideTarget(command, context.workspace(), directory);
                target = command;
            }
            if (outside) return new Decision(Verdict.SANDBOX, "boundary", "操作目标不在已授权工作区内: " + target);
        }
        return NEXT;
    }

    private Decision reviewMode(ReviewContext context) {
        context.pending().removeIf(call -> CONTROL_TOOLS.contains(call.name()));
        return NEXT;
    }

    private Decision reviewReadOnly(ReviewContext context) {
        context.pending().removeIf(call -> {
            var local = loop.getToolRegistry().get(call.name());
            if (local != null && ToolMetadata.readOnlyOverride(local) != null) {
                return ToolMetadata.readOnlyOverride(local);
            }
            var tools = loop.getCutinTools();
            var registered = tools == null ? null : tools.find(call.name()).orElse(null);
            if (local != null ? ToolMetadata.isReadOnly(local)
                    : registered != null && registered.definition().metadata().readOnly()) return true;
            if (local == null && registered == null || context.workspace() == null) return false;
            Object command = ToolCallEntry.parseArguments(call.arguments()).get("command");
            return SHELL_TOOLS.contains(call.name()) && command instanceof String text
                    && ReadOnlyShellCommands.isReadOnly(text);
        });
        return NEXT;
    }

    private Decision reviewWorkspace(ReviewContext context) {
        context.pending().removeIf(call -> {
            var local = loop.getToolRegistry().get(call.name());
            if (local != null && WorkspaceFileOperations.isWorkspaceWrite(call, context.workspace())) return true;
            if (local != null && "memory".equals(call.name()) && context.workspace() != null) return true;
            if (local != null && Boolean.FALSE.equals(ToolMetadata.readOnlyOverride(local))) return false;
            var tools = loop.getCutinTools();
            if (local == null && (tools == null || tools.find(call.name()).isEmpty())) return false;
            if (!SHELL_TOOLS.contains(call.name())) return false;
            var arguments = ToolCallEntry.parseArguments(call.arguments());
            if (!(arguments.get("command") instanceof String text)) return false;
            Path directory = context.workspace();
            if (arguments.get("workdir") instanceof String workdir && !workdir.isBlank()) {
                if (!WorkspaceFileOperations.isWithin(directory, directory, workdir)) return false;
                directory = directory.resolve(workdir);
            }
            return WorkspaceShellCommands.isWorkspaceLocal(text, context.workspace(), directory);
        });
        return NEXT;
    }

    private Decision reviewAi(ReviewContext context) {
        if (!HitlManager.MODE_AUTO.equals(context.mode())) return NEXT;
        ToolCallValidator reviewer = aiReviewer;
        if (!reviewer.enabled()) return NEXT;
        for (ToolCallEntry call : context.pending()) {
            ToolCallValidator.Decision decision = reviewer.validate(call.name(),
                    ONode.ofBean(ToolCallEntry.parseArguments(call.arguments())).toJson());
            // AI 调用期间可能切换权限模式，后续执行按用户最新的选择处理。
            if (!HitlManager.MODE_AUTO.equals(loop.getHitlMode())) {
                return HitlManager.MODE_FREE.equals(loop.getHitlMode())
                        ? new Decision(Verdict.APPROVED, "mode", "已切换为完全自动，跳过审核")
                        : new Decision(Verdict.HUMAN, "mode", "已切换为按需审批，等待用户确认");
            }
            String reason = call.name() + ": " + decision.reason();
            if (decision.requiresHuman()) return new Decision(Verdict.SANDBOX, "ai", reason);
            if (!decision.allowed()) {
                return new Decision(Verdict.HUMAN, "ai",
                        (decision.failed() ? "AI 审核失败，交由人工决定: " : "AI 未批准，交由人工决定: ") + reason);
            }
        }
        context.pending().clear();
        return NEXT;
    }

    private Decision reviewHuman(ReviewContext context) {
        return new Decision(Verdict.HUMAN, "human", "未获自动批准，等待用户确认");
    }

}

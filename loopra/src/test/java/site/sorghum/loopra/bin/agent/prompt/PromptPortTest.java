package site.sorghum.loopra.bin.agent.prompt;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 移植完整性断言：Claude Code 原文里出现的工具名必须全部替换为 Loopra 的等价工具，
 * 否则模型会去调用根本不存在的工具。
 */
class PromptPortTest {

    /** Claude Code 的工具名 —— 一个都不该出现在移植后的文案里。 */
    private static final List<String> CLAUDE_CODE_TOOL_NAMES = List.of(
            "TodoWrite", "AskUserQuestion", "ExitPlanMode", "TaskCreate", "TaskList",
            "TaskGet", "TaskUpdate", "NotebookEdit", "WebFetch", "MultiEdit",
            "SlashCommand", "KillShell", "BashOutput", "WebSearch"
    );

    /** 移植后应当出现的 Loopra 工具名。 */
    private static final List<String> LOOPRA_TOOL_NAMES = List.of(
            "`read`", "`write`", "`edit`", "`glob`", "`grep`", "`bash`",
            "`checklist_start`", "`ask_choice`"
    );

    @Test
    void portedPromptContainsNoClaudeCodeToolNames() {
        String prompt = ClaudeCodePrompt.join();
        for (String name : CLAUDE_CODE_TOOL_NAMES) {
            assertFalse(prompt.contains(name),
                    "移植文案残留 Claude Code 工具名: " + name);
        }
    }

    @Test
    void portedPromptReferencesLoopraTools() {
        String prompt = ClaudeCodePrompt.join();
        for (String name : LOOPRA_TOOL_NAMES) {
            assertTrue(prompt.contains(name),
                    "移植文案缺少 Loopra 工具引用: " + name);
        }
    }

    @Test
    void portedPromptDropsLoopraAbsentSlashCommands() {
        String prompt = ClaudeCodePrompt.join();
        // Loopra 没有 /help、/issue、/share，相关句子必须去掉
        assertFalse(prompt.contains("/help:"), "残留 /help 指引");
        assertFalse(prompt.contains("/share"), "残留 /share 指引");
        assertFalse(prompt.contains("#claude-code-feedback"), "残留反馈频道指引");
    }

    @Test
    void supplementCoversLoopraSpecificTools() {
        String supplement = DEFAULT_PROMPT.PROMPT;
        for (String name : List.of("workspace_write", "workspace_read",
                "goal_complete", "submit_plan", "bash_start", "checklist_step", "memory")) {
            assertTrue(supplement.contains(name),
                    "Loopra 补充缺少特有工具说明: " + name);
        }
        assertFalse(supplement.contains("browser_"));
        assertFalse(ChatModePrompt.PROMPT.contains("browser_"));
        assertFalse(site.sorghum.loopra.integration.cutin.plugin.prompt.ToolContract.build("").contains("browser_"));
    }

    @Test
    void supplementDoesNotRepeatPortedGuidance() {
        String supplement = DEFAULT_PROMPT.PROMPT;
        // 这些主题已由 Claude Code 原文覆盖，补充里不应再出现重复表述
        assertFalse(supplement.contains("外科手术式修改"), "重复了「只动该动的」准则");
        assertFalse(supplement.contains("简洁优先"), "重复了简洁优先准则");
        assertFalse(supplement.contains("如实报告结果"), "重复了如实报告准则");
    }

    @Test
    void planContractStatesInvariantsOnly() {
        String contract = PlanModeContract.TEXT;
        assertTrue(contract.contains("submit_plan"), "计划约定应说明 submit_plan 用法");
        assertTrue(contract.contains("只读"), "计划约定应声明只读约束");
        // 「当前处于计划模式」是易变状态，属于状态通知，不属于常驻 system
        assertFalse(contract.contains("当前处于计划模式"),
                "易变状态不得写入常驻 system 文案");
    }

    @Test
    void toolNamesConstantsMatchPromptText() {
        assertTrue(ClaudeCodePrompt.USING_TOOLS.contains(LoopraToolNames.BASH));
        assertTrue(ClaudeCodePrompt.DOING_TASKS.contains(LoopraToolNames.ASK_CHOICE));
        assertTrue(ClaudeCodePrompt.USING_TOOLS.contains(LoopraToolNames.CHECKLIST_START));
    }
}

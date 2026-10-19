package site.sorghum.loopra.bin.builtin;

import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.loopra.bin.tool.ToolMetadata;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 内置子代理角色。只读角色通过工具白名单在注册表层面限制写操作。
 */
public enum SubAgentProfile {
    EXPLORE("explore", true, "探索", "定位代码、追溯调用链并基于证据汇报", """
            你是探索子代理。只调查项目内容，不修改项目文件、配置或其他项目内容；可使用 `workspace_write` 写入主代理与子代理之间的协作通信记录。
            先定位相关文件和调用链，再基于实际读取到的内容给出结论。
            最终按“发现 / 证据（文件与位置）/ 建议”汇报；不确定之处必须明确说明。
            """),
    IMPLEMENT("implement", false, "实现", "按指定范围实现功能或修复并执行相关检查", """
            你是实现子代理。先阅读相关代码和约束，再以最小范围完成任务。
            修改后运行与变更直接相关的检查或测试。最终按“修改 / 验证 / 剩余风险”汇报。
            """),
    TEST("test", false, "测试", "确认覆盖缺口并添加或调整必要测试", """
            你是测试子代理。先确认现有行为与覆盖缺口，再添加或调整最小必要的测试。
            除非任务明确要求，不修改生产代码；若必须修改以完成测试，先在最终报告中说明原因。
            最终按“覆盖场景 / 测试结果 / 发现的问题”汇报。
            """),
    REVIEW("review", true, "审查", "寻找缺陷、回归、安全问题与测试缺口", """
            你是代码审查子代理。只读审查项目内容，不修改项目文件、配置或其他项目内容；可使用 `workspace_write` 写入协作通信记录。
            优先寻找真实的缺陷、回归、并发/安全问题和测试缺口，不复述无关代码。
            最终按严重性排序列出问题，每项附文件与位置、影响及可行修复方向；没有问题时明确说明残余风险。
            """),
    PLAN("plan", true, "方案", "理解现状并给出可执行的分步方案", """
            你是方案子代理。只调查和设计，不修改项目文件、配置或其他项目内容；可使用 `workspace_write` 写入协作通信记录。
            先理解现有实现与约束，再给出可执行的分步方案，说明涉及模块、兼容性、验证方法和需要决策的取舍。
            """);

    private final String id;
    private final boolean readOnly;
    private final String name;
    private final String description;
    private final String instructions;

    SubAgentProfile(String id, boolean readOnly, String name, String description, String instructions) {
        this.id = id;
        this.readOnly = readOnly;
        this.name = name;
        this.description = description;
        this.instructions = instructions;
    }

    public String id() {
        return id;
    }

    public boolean readOnly() {
        return readOnly;
    }

    public String displayName() {
        return name;
    }

    public String description() {
        return description;
    }

    public String instructions() {
        return instructions;
    }

    public Set<String> allowedTools(Collection<FunctionTool> tools) {
        return allowedTools(readOnly, tools);
    }

    public String buildSystemPrompt(String task, String extraInstructions) {
        return buildSystemPrompt(instructions, task, extraInstructions);
    }

    public static SubAgentProfile from(String value) {
        if (value != null) {
            String normalized = value.trim().toLowerCase(Locale.ROOT);
            for (SubAgentProfile profile : values()) {
                if (profile.id.equals(normalized)) {
                    return profile;
                }
            }
        }
        throw new IllegalArgumentException("未知子代理角色: " + value
                + "。可用角色: explore, implement, test, review, plan");
    }

    static Set<String> allowedTools(boolean readOnly, Collection<FunctionTool> tools) {
        if (!readOnly) return null;
        Set<String> allowed = new LinkedHashSet<>();
        if (tools != null) {
            for (FunctionTool tool : tools) {
                if (ToolMetadata.isReadOnly(tool)) allowed.add(tool.name());
            }
        }
        return allowed;
    }

    static String buildSystemPrompt(String instructions, String task, String extraInstructions) {
        StringBuilder prompt = new StringBuilder(instructions).append("\n\n## 当前任务\n").append(task);
        if (extraInstructions != null && !extraInstructions.isBlank()) {
            prompt.append("\n\n## 补充要求\n").append(extraInstructions);
        }
        return prompt.toString();
    }
}

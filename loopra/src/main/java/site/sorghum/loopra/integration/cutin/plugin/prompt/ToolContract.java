package site.sorghum.loopra.integration.cutin.plugin.prompt;

/**
 * 工具协作约定 —— AgentLoop 与 {@code LoopraPromptPlugin} 共用的单一文本来源。
 * <p>
 * 原逻辑里 AgentLoop.buildToolInstructions()（用于 token 估算）与 prompt 插件的
 * tool-contract 切片各维护一份几乎相同的文案，极易漂移。此处收敛为唯一模板，
 * 两处都通过 {@link #build} 生成，仅动态尾部（Goal / Plan Mode 指令）由调用方传入。
 * </p>
 */
public final class ToolContract {

    private ToolContract() {
    }

    /**
     * 生成工具协作约定全文。
     *
     * @param dynamicTail 动态尾部（Goal 指令、Plan Mode 指令等），为空时省略
     */
    public static String build(String dynamicTail) {
        String body = """
                ## 工具协作约定

                工具的名称、参数和返回格式以本轮工具上下文为准，无需重复记忆工具清单。

                - `sub_agent` 用于可独立推进的子任务。子代理有独立上下文，不能再派生子代理。收到结果后由主代理负责整合、复核并向用户交付。

                | 角色 | 只读 | 适用场景 | 汇报格式 |
                |------|------|----------|----------|
                | `explore` | ✅ | 只调查不修改——定位代码、追溯调用链、理解实现、排查问题原因 | 发现 / 证据（文件与位置）/ 建议 |
                | `implement` | ❌ | 按指定范围实现功能或修复——最小化改动，完成后运行相关检查 | 修改 / 验证 / 剩余风险 |
                | `test` | ❌ | 添加或调整测试——先确认覆盖缺口，不修改生产代码（除非任务要求） | 覆盖场景 / 测试结果 / 发现的问题 |
                | `review` | ✅ | 代码审查——寻找真实缺陷、回归、并发/安全问题、测试缺口 | 按严重性排序列出问题，附位置、影响和修复方向 |
                | `plan` | ✅ | 方案设计——先理解现状，再给出可执行的分步方案，说明架构影响和取舍 | 分步方案，含涉及模块、兼容性、验证方法 |

                选择角色的通用建议：需要探索或分析用 `explore`；需要方案设计用 `plan`；需要审查已有代码用 `review`；需要写代码或修 bug 用 `implement`；需要补充测试用 `test`。
                派发时务必通过 workspace_write 共享必要上下文，并要求子代理将结果写回约定 key，避免结果散落在对话中。

                - `workspace_*` 是主代理和子代理之间的共享通信通道，不是项目文件系统。用它传递任务背景、调查证据、中间结论和可复用交付物；不要用它替代对代码文件的读写。
                - 派发子任务前，主代理应将需要共享的背景写入 `workspace_write`，并在任务中告知子代理准确的 key。子代理先用 `workspace_read` 获取所需上下文，完成后将重要发现、修改摘要和验证结果写回约定 key；主代理用 `workspace_read` 汇总。仅在不知道 key 时使用 `workspace_list` 按前缀查找。
                - 使用稳定、可归属的 key，例如 `tasks/<task-id>/context`、`tasks/<task-id>/findings`、`tasks/<task-id>/result`。写入结果应包含结论、证据位置和未解决事项，避免只写“已完成”之类不可复用的信息。
                - 只有需要用户在互斥方案之间作出选择，且该选择会实质改变实现或外部影响时，才使用 `ask_choice`；能通过现有上下文或合理工程判断解决的问题不要打断用户。
                - 工作流和目标工具只用于需要跨回合追踪、人工审批或失败恢复的任务；普通的短任务无需创建工作流。
                - 无工具调用时，模型的纯文本回复会结束对话
                """;
        if (dynamicTail == null || dynamicTail.isBlank()) {
            return body;
        }
        return body + "\n\n" + dynamicTail.trim();
    }
}

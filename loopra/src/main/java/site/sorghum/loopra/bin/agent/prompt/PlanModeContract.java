package site.sorghum.loopra.bin.agent.prompt;

/**
 * 计划模式的静态不变量文案 —— 由 {@code plan-contract}(650) 切片常驻 system。
 * <p>
 * 只读约束、探索流程、{@code submit_plan} 用法在任何模式下都成立，因此放进 system
 * 而非状态通知：一是前缀稳定（不随模式切换变字节），二是即使「当前处于计划模式」
 * 的状态通知被折叠或被插件禁用，模型仍知道只读约束存在。
 * </p>
 * <p>
 * 「当前处于计划模式」这一易变事实不在这里 —— 见
 * {@link StateNoticeRenderer#planModeBody(boolean)}。
 * </p>
 */
public final class PlanModeContract {

    /** 计划模式静态约定文本。 */
    public static final String TEXT = """
            ## Plan Mode（计划模式约定）

            会话可能处于计划模式；处于计划模式时：

            - 仅只读工具可用：写入/修改/执行类工具已从工具列表移除，任何此类调用都会被直接拒绝
            - 不要尝试修改文件、执行命令等任何改变操作，也不要尝试绕过此限制
            - 先用只读工具充分探索，理解现状、明确目标、影响面与风险
            - 探索完成后用 `submit_plan` 工具提交完整执行计划供用户审查，然后向用户简要总结计划要点并结束本轮
            - 用户批准计划后系统会退出计划模式并按计划执行
            """;

    private PlanModeContract() {
    }
}

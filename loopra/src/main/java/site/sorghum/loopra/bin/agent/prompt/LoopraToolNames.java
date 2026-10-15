package site.sorghum.loopra.bin.agent.prompt;

/**
 * 工具名常量 —— 提示词里一律插值引用，不硬编码字符串。
 * <p>
 * Claude Code 的提示词从不直接写工具名，全部从常量插值，这也是它能在不同构建
 * 里换掉工具集而不改文案的原因。移植过来的 {@link ClaudeCodePrompt} 沿用同一约定：
 * 原文逐字保留，工具名统一从这里取，改名只需改一处。
 * </p>
 */
public final class LoopraToolNames {

    /** 读取文件内容。 */
    public static final String READ = "read";
    /** 创建或覆盖文件。 */
    public static final String WRITE = "write";
    /** 精准文本替换编辑。 */
    public static final String EDIT = "edit";
    /** 按通配符查找文件。 */
    public static final String GLOB = "glob";
    /** 递归搜索文件内容。 */
    public static final String GREP = "grep";
    /** 列出目录内容。 */
    public static final String LS = "ls";
    /** 执行 shell 命令（同步，一次性）。 */
    public static final String BASH = "bash";

    /** 启动后台 shell 会话（交互式/长驻进程）。 */
    public static final String BASH_START = "bash_start";
    /** 继续等待后台会话输出。 */
    public static final String BASH_WAIT = "bash_wait";
    /** 向后台会话写入 stdin。 */
    public static final String BASH_STDIN = "bash_stdin";
    /** 终止后台会话。 */
    public static final String BASH_STOP = "bash_stop";

    /** 派发子代理。 */
    public static final String SUB_AGENT = "sub_agent";
    /** 向用户提问并等待选择。 */
    public static final String ASK_CHOICE = "ask_choice";
    /** 提交计划供用户审查。 */
    public static final String SUBMIT_PLAN = "submit_plan";
    /** 显式结束对话。 */
    public static final String FINISH = "finish";
    /** 抓取网页内容。 */
    public static final String WEB_FETCH = "webfetch";

    /** 创建任务清单。 */
    public static final String CHECKLIST_START = "checklist_start";
    /** 推进清单步骤。 */
    public static final String CHECKLIST_STEP = "checklist_step";
    /** 查询清单状态。 */
    public static final String CHECKLIST_STATUS = "checklist_status";

    /** 主代理与子代理之间的共享上下文通道（非项目文件系统）。 */
    public static final String WORKSPACE_READ = "workspace_read";
    public static final String WORKSPACE_WRITE = "workspace_write";
    public static final String WORKSPACE_LIST = "workspace_list";

    /** 项目级长期记忆。 */
    public static final String MEMORY = "memory";
    /** 重新扫描技能清单。 */
    public static final String SKILL_REFRESH = "skillrefresh";
    /** 读取图片。 */
    public static final String READ_IMAGE = "read_image";

    /** 清单三件套的组合写法，供「管理工作」一句插值。 */
    public static final String CHECKLIST_TRIO =
            "`" + CHECKLIST_START + "` / `" + CHECKLIST_STEP + "` / `" + CHECKLIST_STATUS + "`";

    private LoopraToolNames() {
    }
}

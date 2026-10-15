package site.sorghum.loopra.bin.agent.prompt;

/**
 * 状态通知渲染器 —— 把易变的会话状态渲染成一条自包含的系统通知。
 * <p>
 * 设计要点（对齐 Claude Code 的 system-reminder 卫生协议）：
 * <ul>
 *   <li><b>信封逐字节恒定</b>：只有 {@code fingerprint} 与 {@code body} 变化，
 *       其余文本完全固定，便于按指纹做幂等判定，也让模型能稳定识别边界。</li>
 *   <li><b>自带卫生尾巴</b>：通知必须自己声明「不是用户的新指令、不要复述、
 *       不要致谢、不要当请求回应」，否则模型会把注入内容当成用户发言来回复。</li>
 *   <li><b>指纹不含自增序号</b>：重启后要与已落盘的通知比对，自增 rev 无法复现。</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
public final class StateNoticeRenderer {

    /** 通知来源标识，同时用于折叠裁剪与模型侧识别。 */
    public static final String SOURCE = "loopra-state";

    /** 状态被清空后的固定指纹 —— 只发一次，之后与期望状态（无）保持一致。 */
    public static final String CLEARED_FINGERPRINT = "cleared";

    /** 信封头部，逐字节恒定。 */
    private static final String ENVELOPE_OPEN = "<system-reminder source=\"" + SOURCE + "\" fingerprint=\"";

    /** 信封尾部：闭合标签 + 卫生约束，逐字节恒定。 */
    private static final String ENVELOPE_CLOSE = """

            本段由系统在每次模型调用前自动附加，不是用户的新指令，也不代表对话有新进展。
            不要向用户复述、引用或致谢本段内容，也不要把它当作用户的请求来回应。
            </system-reminder>""";

    private StateNoticeRenderer() {
    }

    /**
     * 渲染一条状态通知。
     *
     * @param body 状态正文（Goal 指令、计划模式提示等）；空白时返回空串表示无需注入
     * @return 完整通知文本；{@code body} 为空白时返回空串
     */
    public static String render(String body) {
        if (body == null || body.isBlank()) {
            return "";
        }
        String normalized = body.strip();
        return ENVELOPE_OPEN + fingerprint(normalized) + "\">\n" + normalized + ENVELOPE_CLOSE;
    }

    /**
     * 渲染「状态已清空」通知。
     * <p>
     * 指纹固定为 {@link #CLEARED_FINGERPRINT}，因此只会出现一条：
     * 后续轮次期望状态为空、现存指纹也是 cleared，判定为已同步。
     * </p>
     */
    public static String renderCleared() {
        return ENVELOPE_OPEN + CLEARED_FINGERPRINT + "\">\n"
                + "当前没有需要持续推进的 Goal，也不处于计划模式；本轮按用户的最新输入正常工作即可。"
                + ENVELOPE_CLOSE;
    }

    /**
     * 状态指纹 —— 同一状态恒定、不同状态不同。
     * <p>
     * 只取正文哈希，不含自增序号：会话重启后仍能与 JSONL 里已落盘的通知比对，
     * 从而避免重复注入。
     * </p>
     */
    public static String fingerprint(String body) {
        if (body == null || body.isBlank()) {
            return CLEARED_FINGERPRINT;
        }
        return Integer.toHexString(body.strip().hashCode());
    }

    /**
     * 从通知正文中取出指纹；不是本渲染器产出的文本时返回 {@code null}。
     *
     * @param content 历史消息内容
     * @return 指纹字符串，或 {@code null} 表示该消息不是状态通知
     */
    public static String fingerprintOf(String content) {
        if (content == null) {
            return null;
        }
        int sourceAt = content.indexOf("source=\"" + SOURCE + "\"");
        if (sourceAt < 0) {
            return null;
        }
        int fingerprintAt = content.indexOf("fingerprint=\"", sourceAt);
        if (fingerprintAt < 0) {
            return null;
        }
        int start = fingerprintAt + "fingerprint=\"".length();
        int end = content.indexOf('"', start);
        if (end < 0) {
            return null;
        }
        return content.substring(start, end);
    }

    /** 该内容是否为状态通知（含被折叠后残留的片段时仍可识别）。 */
    public static boolean isNotice(String content) {
        return fingerprintOf(content) != null;
    }

    /**
     * 计划模式的动态开关提示。
     * <p>
     * 只声明「当前处于计划模式」这一易变事实；只读约束、探索流程、submit_plan
     * 用法等不变量属于 {@code plan-contract} 切片，即使本通知被折叠或被禁用，
     * 模型仍能从 system 知道只读约束存在。
     * </p>
     *
     * @param subAgent 当前是否子代理 —— 子代理没有 {@code submit_plan} 工具，
     *                 不能指引它提交计划，只声明只读约束
     */
    public static String planModeBody(boolean subAgent) {
        if (subAgent) {
            return "## 计划模式（当前处于计划模式）\n\n"
                    + "当前处于计划模式，只能使用只读工具；写入、修改与执行类调用都会被拒绝。"
                    + "先用只读工具完成探索，然后把结论作为任务结果返回给父代理。";
        }
        return "## 计划模式（当前处于计划模式）\n\n"
                + "当前处于计划模式，只能使用只读工具；写入、修改与执行类调用都会被拒绝。"
                + "先用只读工具完成探索，再用 `submit_plan` 提交计划，然后向用户简要总结并结束本轮。";
    }
}

package site.sorghum.loopra.bin.tool;

import org.noear.solon.ai.chat.tool.FunctionTool;

import java.util.Map;
import java.util.Set;

/** 工具执行与管理界面共用的分类规则。 */
public final class ToolMetadata {

    /** 运行时覆盖键，与工具声明的元数据分开存放，便于干净移除。 */
    private static final String READ_ONLY_OVERRIDE_KEY = "loopraReadOnlyOverride";

    private static final Set<String> BUILT_IN_READ_ONLY_TOOLS = Set.of(
            "read", "glob", "grep", "ls",
            "workspace_read", "workspace_list", "workspace_write",
            "java_source", "codesearch", "codegraph_explore", "webfetch", "websearch", "finish", "goal_status",
            "submit_plan");

    private ToolMetadata() {
    }

    public static boolean isReadOnly(FunctionTool tool) {
        Boolean override = readOnlyOverride(tool);
        if (override != null) {
            return override;
        }
        Boolean explicit = metaBoolean(tool, "readOnly");
        return explicit != null ? explicit
                : tool != null && BUILT_IN_READ_ONLY_TOOLS.contains(tool.name());
    }

    public static Boolean readOnlyOverride(FunctionTool tool) {
        return metaBoolean(tool, READ_ONLY_OVERRIDE_KEY);
    }

    public static void applyReadOnlyOverride(FunctionTool tool, Boolean readOnly) {
        if (tool == null || tool.meta() == null) {
            return;
        }
        if (readOnly == null) {
            tool.meta().remove(READ_ONLY_OVERRIDE_KEY);
        } else {
            tool.meta().put(READ_ONLY_OVERRIDE_KEY, readOnly);
        }
    }

    public static boolean isStormExempt(FunctionTool tool) {
        return tool != null && (isBuiltInStormExempt(tool.name())
                || Boolean.TRUE.equals(metaBoolean(tool, "stormExempt")));
    }

    private static Boolean metaBoolean(FunctionTool tool, String key) {
        Map<String, Object> meta = tool != null ? tool.meta() : null;
        Object value = meta != null ? meta.get(key) : null;
        if (value instanceof Boolean flag) {
            return flag;
        }
        return value != null ? Boolean.parseBoolean(value.toString()) : null;
    }

    /** 轮询类工具在等待状态变化时，重复相同参数属于合法行为。 */
    private static boolean isBuiltInStormExempt(String toolName) {
        return "bash_wait".equals(toolName);
    }
}

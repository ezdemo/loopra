package site.sorghum.loopra.tool.interact;

import org.noear.snack4.ONode;
import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.tool.AbsToolProvider;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ErrorCodes;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.ToolContext;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 用户选择菜单工具 —— 通过 {@link AgentOutput#ask} 向用户展示多选菜单。
 *
 * @author Sorghum
 */
@Component
public class AskChoiceTool extends AbsToolProvider implements SolonToTools {

    @ToolMapping(name = "ask_choice", description = """
                向用户展示选择菜单（2-6 个选项），等待用户选择。allowCustom=true 允许自定义输入。
                """)
    public String askChoice(@Param(name = "question", description = "问题") String question,
                            @Param(name = "options", description = "选项列表") List<Object> options,
                            @Param(name = "allowCustom", description = "是否允许自定义输入", required = false) Boolean allowCustom,
                            @Param(name = "ctx", required = false) ToolContext ctx) {
        // 通过 AgentLoopController 获取输出通道
        AgentLoopController ctrl = ctx.getLoopController();
        if (ctrl == null) {
            return ErrorCodes.NO_CONTROLLER + ": 没有可用的 AgentLoop 控制器，无法展示选择菜单";
        }
        AgentOutput output = ctrl.getOutput();
        if (output == null) {
            return ErrorCodes.NO_OUTPUT + ": 没有可用的输出通道，无法展示选择菜单";
        }

        List<Map<String, Object>> normalizedOptions = normalizeOptions(options);
        String result = output.ask(
                question,
                normalizedOptions,
                allowCustom != null ? allowCustom : false
        );
        ctrl.requestStop();
        return result;
    }

    /**
     * 将 options 统一转换为 List&lt;Map&lt;String, Object&gt;&gt; 格式。
     * <p>支持的入参形态：
     * <ul>
     *   <li>{@code {"title":"...", "value":"...", "summary":"..."}} —— 标准 map，原样保留</li>
     *   <li>{@code {"label":"...", "value":"..."}} —— 兼容 label，自动映射为 title</li>
     *   <li>纯字符串 —— 包装为 {@code {"title": item}}</li>
     *   <li>其他对象 —— {@code String.valueOf} 后包装为 title</li>
     * </ul>
     * </p>
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> normalizeOptions(List<?> raw) {
        if (raw == null || raw.isEmpty()) return new ArrayList<>();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : raw) {
             if (item instanceof String) {
                Map<String, Object> opt = new java.util.HashMap<>();
                opt.put("title", item);
                result.add(opt);
            } else {
                Map<String, Object> opt = new java.util.HashMap<>();
                 Map itemMap = ONode.ofBean(item).toBean(Map.class);
                 String title = (String) itemMap.keySet()
                         .stream()
                         .sorted()
                         .map(itemMap::get)
                         .map(Object::toString)
                         .collect(Collectors.joining(" "));
                 opt.put("title", title);
                result.add(opt);
            }
        }
        return result;
    }

    @Override
    public Collection<FunctionTool> getSolonTools() {
        return this.getTools();
    }

}


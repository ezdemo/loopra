package site.sorghum.loopra.bin.builtin;

import org.noear.solon.ai.chat.tool.FunctionTool;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 子代理角色配置。支持通过 {@code ~/.loopra/sub-agents.json} 覆盖内置默认值
 * （按 id 合并，也可新增自定义角色），修改配置文件后下次调用立即生效。
 */
public class SubAgentProfileConfig {

    /** 角色 id，如 explore（稳定标识，不可变更，按 id 合并） */
    public String id;
    /** 展示名（缺省回退为 id） */
    public String name;
    /** 展示描述（可空） */
    public String description;
    /** 是否启用（缺省视为启用；false 时该角色不对外提供） */
    public Boolean enable;
    /** 只读角色：未显式配置 allowedTools 时默认只暴露只读工具 */
    public boolean readOnly;
    /** 预置系统提示词 */
    public String instructions;
    /** 显式工具白名单（可空：readOnly 角色用只读工具集，可写角色用全部工具） */
    public List<String> allowedTools;
    /** 独立模型渠道 id（可空：继承父级/主代理渠道） */
    public String modelChannel;
    /** 渠道内模型名（可空：使用渠道默认模型） */
    public String model;

    public boolean enabled() {
        return enable == null || enable;
    }

    public String id() {
        return id;
    }

    public boolean readOnly() {
        return readOnly;
    }

    public String instructions() {
        return instructions;
    }

    public String name() {
        return name != null && !name.isBlank() ? name : id;
    }

    public String description() {
        return description == null ? "" : description;
    }

    /**
     * 计算实际允许的工具；返回 null 表示不限制（可写角色默认）。
     * 显式配置了 allowedTools 时以其为准，不再叠加 readOnly 过滤。
     */
    public Set<String> allowedTools(Collection<FunctionTool> tools) {
        return allowedTools != null && !allowedTools.isEmpty()
                ? new LinkedHashSet<>(allowedTools)
                : SubAgentProfile.allowedTools(readOnly, tools);
    }

    public String buildSystemPrompt(String task, String extraInstructions) {
        return SubAgentProfile.buildSystemPrompt(instructions, task, extraInstructions);
    }
}

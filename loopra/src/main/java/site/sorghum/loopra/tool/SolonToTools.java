package site.sorghum.loopra.tool;

import org.noear.solon.ai.chat.tool.FunctionTool;

import java.util.Collection;
import java.util.Collections;

/**
 * Solon 工具集合提供者 —— 将一组 {@link FunctionTool} 及其系统提示词贡献给工具扫描。
 * <p>
 * 内置工具与 Skill（MCP/OpenAPI/WebFetch 等）实现此接口，
 * 由上层工具扫描统一收集。
 * </p>
 *
 * @author Sorghum
 */
public interface SolonToTools {

    default Collection<FunctionTool> getSolonTools() {
        return Collections.emptyList();
    }

    default String getSystemPrompt() {
        return null;
    }
}

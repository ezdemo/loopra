package site.sorghum.loopra.tool.solon.webfetch;

import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.talents.web.CodeSearchTalent;
import org.noear.solon.ai.talents.web.WebfetchTalent;
import org.noear.solon.ai.talents.web.WebsearchTalent;
import org.noear.solon.annotation.Component;
import site.sorghum.loopra.tool.SolonToTools;

import java.util.Collection;
import java.util.stream.Stream;

/** 将 Solon 网页抓取与代码搜索能力暴露为 Loopra 可调用的工具集合。 */
@Component
public class LoopraWebSkill implements SolonToTools {

    WebfetchTalent fetchTool = new WebfetchTalent();

    CodeSearchTalent codeSearchTool = new CodeSearchTalent();

    WebsearchTalent searchTool = new WebsearchTalent();

    @Override
    public Collection<FunctionTool> getSolonTools() {
        return Stream.of(
                fetchTool,
                codeSearchTool,
                searchTool
        ).map(
                it -> it.getTools(null)
        ).flatMap(Collection::stream).toList();
    }
}

package site.sorghum.loopra.tool.solon.common;

import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.talents.cli.SkillTalent;
import org.noear.solon.ai.talents.mount.MountManager;
import org.noear.solon.ai.talents.mount.catalog.SkillCatalog;

/** Loopra 对框架技能工具的展示增强。 */
public class LoopraSkillTalent extends SkillTalent {
    public LoopraSkillTalent(MountManager mountManager) {
        super(mountManager.getSkillCatalog());
    }

    public LoopraSkillTalent(SkillCatalog skillCatalog) {
        super(skillCatalog);
    }

    /**
     * 刷新后直接返回与 skilllist 相同的内容，使 Agent 立即看到完整的可用技能。
     */
    @Override
    @ToolMapping(name = "skillrefresh", description = "重新扫描所有挂载点，并返回刷新后的可用技能清单。")
    public String skillrefresh() {
        getSkillCatalog().refresh();
        return skilllist();
    }
}

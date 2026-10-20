package site.sorghum.loopra.tool.solon.common;

import lombok.Getter;
import lombok.SneakyThrows;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.talents.mount.Mount;
import org.noear.solon.ai.talents.mount.MountManager;
import org.noear.solon.ai.talents.mount.MountType;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.solon.mcp.ProjectMcpSkill;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collection;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/** 基于 Solon MountManager 的 Loopra 技能/终端能力提供者。 */
public class LoopraSkillProvider implements SolonToTools {
    LoopraSkillTalent skillTalent;
    SessionTerminalTalent terminalTalent;
    @Getter
    ProjectMcpSkill projectMcpSkill;
    public static Map<String, LoopraSkillProvider> cliSkillProviderMap = new ConcurrentHashMap<>();
    @Getter
    public MountManager poolManager;

    @SneakyThrows
    public LoopraSkillProvider(String workDir) {
        Files.createDirectories(Paths.get(System.getProperty("user.home"), ".loopra", "skills"));
        poolManager = new MountManager(workDir);
        poolManager.register(Mount.builder()
                .type(MountType.SKILLS)
                .alias("@loopra-skills")
                .source(new SkillFileMountSource(Paths.get(System.getProperty("user.home"), ".loopra", "skills")))
                .build());
        // 项目 Skill 与用户 Skill 分开挂载；不存在时保留挂载，后续 refresh 可发现新目录。
        if (workDir != null && !workDir.isBlank() && !"~".equals(workDir)) {
            Path projectSkills = Paths.get(workDir).toAbsolutePath().normalize()
                    .resolve(".loopra").resolve("skills");
            poolManager.register(Mount.builder()
                    .type(MountType.SKILLS)
                    .alias("@project-skills")
                    .source(new SkillFileMountSource(projectSkills))
                    .build());
        }
        skillTalent = new LoopraSkillTalent(poolManager);
        terminalTalent = new SessionTerminalTalent(poolManager, workDir);
        terminalTalent.setSandboxEnabled(false);
        terminalTalent.setBashAsyncEnabled(true);
        projectMcpSkill = ProjectMcpSkill.load(Paths.get(workDir));
    }

    public static LoopraSkillProvider getOrCreate(String rootDir) {
        return cliSkillProviderMap.computeIfAbsent(rootDir, k -> new LoopraSkillProvider(rootDir));
    }

    /**
     * 移除指定根目录的 skill provider（隔离分支删除后调用，避免 MountManager 缓存无限增长）。
     * 底层 TerminalSessionManager 的生命周期由 solon-ai 管理，此处仅移除映射。
     */
    public static void removeFor(String rootDir) {
        if (rootDir == null) return;
        LoopraSkillProvider removed = cliSkillProviderMap.remove(
                Paths.get(rootDir).toAbsolutePath().normalize().toString());
        if (removed != null && removed.projectMcpSkill != null) {
            removed.projectMcpSkill.close();
        }
    }

     /** 已安装技能目录变化后，刷新所有启用的技能池。 */
    public static void refreshAllSkillPools() {
        cliSkillProviderMap.values().forEach(provider -> provider.poolManager.getSkillCatalog().refresh());
    }


    @Override
    public Collection<FunctionTool> getSolonTools() {
        return Stream.of(
                skillTalent,
                terminalTalent,
                projectMcpSkill
        ).filter(Objects::nonNull).map(
                talent -> talent.getTools(null)
        ).filter(
                Objects::nonNull
        ).flatMap(Collection::stream).filter(
                Objects::nonNull
        ).toList();
    }

    @Override
    public String getSystemPrompt() {
        return """
                ## 技能库执行规约
                ### 运行模式: 路径导航
                优先使用合适的技能解决问题（不确定用什么技能时，可通过 skillsearch 搜索）。
                注意：在执行任务中，请务必通过 skillread 读取或回顾规约。
                当前技能较多，仅展示路径索引（没有描述）。请推断功能并调用 skillread。
                如果不确定，请使用 skillsearch 检索
                """;
    }

}

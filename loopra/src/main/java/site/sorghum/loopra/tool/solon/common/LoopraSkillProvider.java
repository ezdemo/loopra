package site.sorghum.loopra.tool.solon.common;

import lombok.Getter;
import lombok.SneakyThrows;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.talents.mount.Mount;
import org.noear.solon.ai.talents.mount.MountManager;
import org.noear.solon.ai.talents.mount.MountType;
import org.noear.solon.ai.talents.mount.source.ClasspathMountSource;
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
    public static final String BUILTIN_SKILLS_ALIAS = "@builtin-skills";
    public static final String SELF_SKILL_ID = BUILTIN_SKILLS_ALIAS + "/self-skill";
    static final String BUILTIN_SKILLS_RESOURCE = "loopra/skills";

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
        // 随 JAR 发布的只读技能，与用户/项目技能保持独立命名空间。
        poolManager.register(Mount.builder()
                .type(MountType.SKILLS)
                .alias(BUILTIN_SKILLS_ALIAS)
                .source(ClasspathMountSource.of(LoopraSkillProvider.class.getClassLoader(), BUILTIN_SKILLS_RESOURCE))
                .build());
        poolManager.register(Mount.builder()
                .type(MountType.SKILLS)
                .alias("@loopra-skills")
                .source(new SkillFileMountSource(Paths.get(System.getProperty("user.home"), ".loopra", "skills")))
                .build());
        // 通用技能目录只挂载读取；不存在时后续 skillrefresh 仍可发现。
        poolManager.register(Mount.builder()
                .type(MountType.SKILLS)
                .alias("@agents-skills")
                .source(new SkillFileMountSource(Paths.get(System.getProperty("user.home"), ".agents", "skills")))
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
                ## Loopra 能力入口
                首次处理任务前，调用 skillread(name="%s") 读取内置 SelfSkill，了解能力发现、技能加载与扩展方式。
                当前上下文已包含该技能时无需重复读取；折叠后缺失相关规约或不确定能力如何使用时重新读取。
                实际可用能力以本轮工具定义、技能目录和工具返回为准。

                """.formatted(SELF_SKILL_ID) + skillTalent.getInstruction(null);
    }

}

package site.sorghum.loopra.tool.solon.common;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.chat.tool.FunctionTool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class LoopraSkillProviderTest {
    @TempDir
    Path workspace;

    @Test
    void userAndProjectSkillsKeepDistinctAliasesAndRefreshDiscoversNewDirectories() throws Exception {
        String previousHome = System.getProperty("user.home");
        Path home = Files.createDirectories(workspace.resolve("home"));
        System.setProperty("user.home", home.toString());
        try {
            Path userSkill = home.resolve(".loopra/skills/example/SKILL.md");
            Files.createDirectories(userSkill.getParent());
            Files.writeString(userSkill, "---\ndescription: User example\n---\nUser skill body.");
            LoopraSkillProvider provider = LoopraSkillProvider.getOrCreate(workspace.toString());
            var catalog = provider.getPoolManager().getSkillCatalog();
            assertNotNull(catalog.getDescriptor("@loopra-skills/example"));
            assertNull(catalog.getDescriptor("@project-skills/example"));

            Path projectSkill = workspace.resolve(".loopra/skills/example/SKILL.md");
            Files.createDirectories(projectSkill.getParent());
            Files.writeString(projectSkill, "---\ndescription: Project example\n---\nProject skill body.");
            LoopraSkillProvider.refreshAllSkillPools();

            assertEquals(2, catalog.getSkillCount());
            assertTrue(catalog.readContent("@loopra-skills/example").getText().contains("User skill body."));
            assertTrue(catalog.readContent("@project-skills/example").getText().contains("Project skill body."));
            assertEquals(projectSkill.getParent(), provider.getPoolManager()
                    .resolveResource("@project-skills/example").getLocalPath().orElseThrow());
            assertTrue(new LoopraSkillTalent(catalog).skillread("@project-skills/example", null)
                    .contains("Project skill body."));
        } finally {
            LoopraSkillProvider.removeFor(workspace.toString());
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void projectToolsWorkWithoutALanguageServerOrSharedApplicationContext() throws IOException {
        Path skill = workspace.resolve(".loopra/skills/example/SKILL.md");
        Files.createDirectories(skill.getParent());
        Files.writeString(skill, "---\nname: example\ndescription: Test project skill\n---\nRead project files.");
        LoopraSkillProvider provider = new LoopraSkillProvider(workspace.toString());
        Set<String> names = provider.getSolonTools().stream()
                .map(FunctionTool::name).collect(Collectors.toSet());

        assertTrue(names.contains("bash"), "terminal tools remain available");
        assertTrue(names.contains("bash_wait"), "command waiting remains available");
        assertTrue(names.contains("bash_stdin"), "the existing stdin tool remains available");
        assertTrue(names.contains("skillread"), "installed project skills remain available");
        assertTrue(names.stream().noneMatch(name -> name.startsWith("lsp")),
                "project tools must not expose the removed language server capability");
    }
}

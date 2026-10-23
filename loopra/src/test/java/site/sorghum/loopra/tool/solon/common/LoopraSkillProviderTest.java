package site.sorghum.loopra.tool.solon.common;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.chat.tool.FunctionTool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class LoopraSkillProviderTest {
    @TempDir
    Path workspace;

    @Test
    void linkedSkillsCanBeDiscoveredReadAndRefreshedWithoutAllowingNestedEscapes() throws Exception {
        String previousHome = System.getProperty("user.home");
        Path home = Files.createDirectories(workspace.resolve("home"));
        System.setProperty("user.home", home.toString());
        try {
            Path installed = Files.createDirectories(home.resolve(".loopra/skills"));
            Path shared = Files.createDirectories(workspace.resolve("shared library/browser-use"));
            Files.writeString(shared.resolve("SKILL.md"), "---\ndescription: Browser skill\n---\nLinked browser body.");
            directoryLink(installed.resolve("browser-use"), shared);
            Path common = Files.createDirectories(home.resolve(".agents/skills"));
            directoryLink(common.resolve("browser-use"), shared);
            Path ordinary = Files.createDirectories(installed.resolve("ordinary"));
            Files.writeString(ordinary.resolve("SKILL.md"), "---\ndescription: Ordinary skill\n---\nOrdinary body.");
            Path outside = Files.createDirectories(workspace.resolve("private"));
            Files.writeString(outside.resolve("secret.txt"), "must not be exposed");
            directoryLink(shared.resolve("escape"), outside);
            directoryLink(installed.resolve("broken"), workspace.resolve("missing"));

            LoopraSkillProvider provider = LoopraSkillProvider.getOrCreate(workspace.toString());
            var catalog = provider.getPoolManager().getSkillCatalog();
            assertEquals(4, catalog.getSkillCount());
            assertTrue(catalog.readContent("@loopra-skills/browser-use").getText().contains("Linked browser body."));
            assertTrue(catalog.readContent("@agents-skills/browser-use").getText().contains("Linked browser body."));
            assertEquals(common.resolve("browser-use"), provider.getPoolManager()
                    .resolveResource("@agents-skills/browser-use").getLocalPath().orElseThrow());
            assertNotNull(catalog.readContent("@loopra-skills/ordinary"));
            assertEquals(installed.resolve("browser-use"), provider.getPoolManager()
                    .resolveResource("@loopra-skills/browser-use").getLocalPath().orElseThrow());
            SkillFileMountSource source = new SkillFileMountSource(installed);
            assertThrows(SecurityException.class, () -> source.openRead("browser-use/escape/secret.txt"));
            assertThrows(SecurityException.class, () -> source.openRead("../private/secret.txt"));

            Path projectSkills = Files.createDirectories(workspace.resolve(".loopra/skills"));
            directoryLink(projectSkills.resolve("browser-use"), shared);
            LoopraSkillProvider.refreshAllSkillPools();
            assertEquals(5, catalog.getSkillCount());
            assertNotNull(catalog.readContent("@project-skills/browser-use"));
        } finally {
            LoopraSkillProvider.removeFor(workspace.toString());
            System.setProperty("user.home", previousHome);
        }
    }

    private static void directoryLink(Path link, Path target) throws Exception {
        if (System.getProperty("os.name").toLowerCase(Locale.ROOT).startsWith("windows")) {
            Process process = new ProcessBuilder("cmd.exe", "/c", "mklink", "/J", link.toString(), target.toString())
                    .redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes());
            assertEquals(0, process.waitFor(), output);
        } else {
            Files.createSymbolicLink(link, target);
        }
    }

    @Test
    void userCommonAndProjectSkillsKeepDistinctAliasesAndRefreshDiscoversNewDirectories() throws Exception {
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
            assertNull(catalog.getDescriptor("@agents-skills/example"));
            assertFalse(Files.exists(home.resolve(".agents/skills")), "mounting does not create the common directory");

            Path projectSkill = workspace.resolve(".loopra/skills/example/SKILL.md");
            Files.createDirectories(projectSkill.getParent());
            Files.writeString(projectSkill, "---\ndescription: Project example\n---\nProject skill body.");
            Path commonSkill = home.resolve(".agents/skills/example/SKILL.md");
            Files.createDirectories(commonSkill.getParent());
            Files.writeString(commonSkill, "---\ndescription: Common example\n---\nCommon skill body.");
            LoopraSkillProvider.refreshAllSkillPools();

            assertEquals(4, catalog.getSkillCount());
            assertTrue(catalog.readContent("@loopra-skills/example").getText().contains("User skill body."));
            assertTrue(catalog.readContent("@project-skills/example").getText().contains("Project skill body."));
            LoopraSkillTalent talent = new LoopraSkillTalent(catalog);
            assertTrue(talent.skillread("@agents-skills/example", null).contains("Common skill body."));
            assertTrue(talent.skillsearch("Common example").contains("@agents-skills/example"));
            assertEquals(commonSkill.getParent(), provider.getPoolManager()
                    .resolveResource("@agents-skills/example").getLocalPath().orElseThrow());
            Path otherWorkspace = Files.createDirectories(workspace.resolve("other"));
            assertTrue(new LoopraSkillProvider(otherWorkspace.toString()).getPoolManager().getSkillCatalog()
                    .readContent("@agents-skills/example").getText().contains("Common skill body."));
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

package site.sorghum.loopra.tool.solon.common;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.talents.mount.Mount;
import org.noear.solon.ai.talents.mount.MountManager;
import org.noear.solon.ai.talents.mount.MountType;
import org.noear.solon.ai.talents.mount.source.ClasspathMountSource;

import java.io.IOException;
import java.net.JarURLConnection;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class BuiltinSkillTest {
    @TempDir
    Path workspace;

    @Test
    void freshInstallCanDiscoverAndReadSelfSkillWithoutInstallingUserSkills() throws Exception {
        String previousHome = System.getProperty("user.home");
        Path home = Files.createDirectories(workspace.resolve("home"));
        System.setProperty("user.home", home.toString());
        try {
            LoopraSkillProvider provider = new LoopraSkillProvider(workspace.toString());
            LoopraSkillTalent talent = new LoopraSkillTalent(provider.getPoolManager());
            assertEquals(1, talent.getSkillCatalog().getSkillCount());
            assertTrue(talent.skilllist().contains(LoopraSkillProvider.SELF_SKILL_ID));
            assertTrue(talent.skillsearch("SelfSkill").contains(LoopraSkillProvider.SELF_SKILL_ID));
            String content = talent.skillread(LoopraSkillProvider.SELF_SKILL_ID, null);
            assertTrue(content.contains("# SelfSkill"));
            assertTrue(content.contains("mcprefresh"));
            assertTrue(content.contains("@project-skills/example"));

            String prompt = provider.getSystemPrompt();
            assertTrue(prompt.contains("skillread(name=\"" + LoopraSkillProvider.SELF_SKILL_ID + "\")"));
            assertTrue(prompt.contains("摘要发现"));
            assertFalse(prompt.contains("# SelfSkill"), "full guide is read on demand");
            Set<String> tools = provider.getSolonTools().stream().map(FunctionTool::name).collect(Collectors.toSet());
            assertTrue(tools.containsAll(Set.of("skillread", "skillrefresh")));
            assertFalse(tools.contains("skillsearch"), "small catalogs use the supplied summary");
            try (var files = Files.list(home.resolve(".loopra/skills"))) {
                assertEquals(0, files.count(), "built-ins do not populate user installations");
            }
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void sameNamedUserAndProjectSkillsRemainIndependentAfterRefresh() throws Exception {
        String previousHome = System.getProperty("user.home");
        Path home = Files.createDirectories(workspace.resolve("home"));
        System.setProperty("user.home", home.toString());
        try {
            LoopraSkillProvider provider = new LoopraSkillProvider(workspace.toString());
            var catalog = provider.getPoolManager().getSkillCatalog();
            String builtin = catalog.readContent(LoopraSkillProvider.SELF_SKILL_ID).getText();
            writeSkill(home.resolve(".loopra/skills/self-skill/SKILL.md"), "User guide.");
            writeSkill(workspace.resolve(".loopra/skills/self-skill/SKILL.md"), "Project guide.");

            String refreshed = new LoopraSkillTalent(catalog).skillrefresh();
            assertEquals(3, catalog.getSkillCount());
            assertTrue(refreshed.contains(LoopraSkillProvider.SELF_SKILL_ID));
            assertEquals(builtin, catalog.readContent(LoopraSkillProvider.SELF_SKILL_ID).getText());
            assertTrue(catalog.readContent("@loopra-skills/self-skill").getText().contains("User guide."));
            assertTrue(catalog.readContent("@project-skills/self-skill").getText().contains("Project guide."));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void jarWithoutDirectoryEntriesDiscoversSelfSkillThroughPackagedIndexAndRemainsReadOnly() throws Exception {
        String root = LoopraSkillProvider.BUILTIN_SKILLS_RESOURCE + "/";
        Path jar = workspace.resolve("builtin-skills.jar");
        try (JarOutputStream output = new JarOutputStream(Files.newOutputStream(jar))) {
            // Deliberately omit directory entries: some packagers only retain files.
            for (String resource : new String[]{"index", "self-skill/SKILL.md"}) {
                output.putNextEntry(new JarEntry(root + resource));
                try (var input = LoopraSkillProvider.class.getClassLoader().getResourceAsStream(root + resource)) {
                    assertNotNull(input, "missing bundled resource: " + resource);
                    input.transferTo(output);
                }
                output.closeEntry();
            }
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{jar.toUri().toURL()}, null)) {
            try {
                ClasspathMountSource source = ClasspathMountSource.of(loader, LoopraSkillProvider.BUILTIN_SKILLS_RESOURCE);
                MountManager manager = new MountManager(workspace.toString());
                manager.register(Mount.builder().type(MountType.SKILLS)
                        .alias(LoopraSkillProvider.BUILTIN_SKILLS_ALIAS).source(source).build());
                LoopraSkillTalent talent = new LoopraSkillTalent(manager);
                assertEquals(1, talent.getSkillCatalog().getSkillCount());
                assertTrue(talent.skillread(LoopraSkillProvider.SELF_SKILL_ID, null).contains("# SelfSkill"));
                assertTrue(talent.skillrefresh().contains(LoopraSkillProvider.SELF_SKILL_ID));
                assertThrows(UnsupportedOperationException.class, () -> source.openWrite("self-skill/SKILL.md", null));
                assertThrows(UnsupportedOperationException.class, () -> source.delete("self-skill/SKILL.md"));
                assertThrows(UnsupportedOperationException.class, () -> source.move("self-skill/SKILL.md", "other", null));
            } finally {
                // ResourceUtil uses URLConnection's JAR cache; release its Windows file handle.
                URL index = loader.getResource(root + "index");
                if (index != null) ((JarURLConnection) index.openConnection()).getJarFile().close();
            }
        }
    }

    private static void writeSkill(Path file, String body) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, "---\nname: self-skill\ndescription: Custom guide\n---\n" + body);
    }
}

package site.sorghum.loopra.web.controller;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class SkillMarketControllerTest {
    @TempDir
    Path home;
    private String previousHome;
    private SkillMarketController controller;

    @BeforeEach
    void setUp() {
        previousHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
        controller = new SkillMarketController();
    }

    @AfterEach
    void restoreHome() {
        System.setProperty("user.home", previousHome);
    }

    @Test
    void rejectsBuiltinSourceWithoutDeletingSameNamedUserSkill() throws Exception {
        Path skill = writeSkill("self-skill", "self-skill");

        var response = controller.uninstall("self-skill", LoopraSkillProvider.SELF_SKILL_ID);

        assertFalse(response.isSuccess());
        assertEquals("内置技能不可卸载", response.getError());
        assertTrue(Files.exists(skill));
        assertFalse(controller.uninstall("self-skill", LoopraSkillProvider.BUILTIN_SKILLS_ALIAS).isSuccess());
        assertTrue(Files.exists(skill));
    }

    @Test
    void rejectsQualifiedBuiltinIdEvenWithoutScope() throws Exception {
        Path skill = writeSkill("self-skill", "self-skill");

        var response = controller.uninstall(LoopraSkillProvider.SELF_SKILL_ID, "");

        assertFalse(response.isSuccess());
        assertEquals("内置技能不可卸载", response.getError());
        assertTrue(Files.exists(skill));
    }

    @Test
    void removesSameNamedUserSkillWhileBuiltinRemainsReadable() throws Exception {
        Path skill = writeSkill("self-skill", "self-skill");
        LoopraSkillProvider provider = new LoopraSkillProvider(home.resolve("workspace").toString());

        assertTrue(controller.uninstall("self-skill", "").isSuccess());

        assertFalse(Files.exists(skill.getParent()));
        provider.getPoolManager().getSkillCatalog().refresh();
        assertTrue(provider.getPoolManager().getSkillCatalog()
                .readContent(LoopraSkillProvider.SELF_SKILL_ID).getText().contains("# SelfSkill"));
    }

    @Test
    void removesUserSkillUsingDirectoryOrFrontmatterName() throws Exception {
        Path first = writeSkill("author-first", "first");
        Path second = writeSkill("author-second", "second");

        assertTrue(controller.uninstall("author-first", "").isSuccess());
        assertFalse(Files.exists(first.getParent()));
        assertTrue(controller.uninstall("second", "").isSuccess());
        assertFalse(Files.exists(second.getParent()));
    }

    @Test
    void rejectsInvalidSlugsWithoutChangingTargetsOrDeletingSkillsRoot() throws Exception {
        Path skill = writeSkill("example", "example");
        for (String slug : new String[]{".", "..", "../example", "example/", "example!"}) {
            assertFalse(controller.uninstall(slug, "").isSuccess(), slug);
            assertTrue(Files.exists(skill), slug);
        }
    }

    private Path writeSkill(String directory, String name) throws Exception {
        Path file = home.resolve(".loopra/skills").resolve(directory).resolve("SKILL.md");
        Files.createDirectories(file.getParent());
        Files.writeString(file, "---\nname: " + name + "\ndescription: User skill\n---\nUser instructions.");
        return file;
    }
}

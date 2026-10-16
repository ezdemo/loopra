package site.sorghum.loopra.tool.solon.common;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.chat.tool.FunctionTool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertTrue;

class LoopraSkillProviderTest {
    @TempDir
    Path workspace;

    @Test
    void projectToolsWorkWithoutALanguageServerOrSharedApplicationContext() throws IOException {
        Path skill = workspace.resolve(".loopra/skills/example/SKILL.md");
        Files.createDirectories(skill.getParent());
        Files.writeString(skill, "---\nname: example\ndescription: Test project skill\n---\nRead project files.");
        LoopraSkillProvider provider = new LoopraSkillProvider(workspace.toString());
        Set<String> names = provider.getSolonTools().stream()
                .map(FunctionTool::name).collect(Collectors.toSet());

        assertTrue(names.contains("bash"), "terminal tools remain available");
        assertTrue(names.contains("skillread"), "installed project skills remain available");
        assertTrue(names.stream().noneMatch(name -> name.startsWith("lsp")),
                "project tools must not expose the removed language server capability");
    }
}

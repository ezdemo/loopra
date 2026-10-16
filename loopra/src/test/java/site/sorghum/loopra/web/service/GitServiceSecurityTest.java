package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.entity.ProcessResult;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class GitServiceSecurityTest {
    @TempDir
    Path workspace;

    private final GitService service = new GitService();

    @Test
    void normalizesAPathWithinTheWorkspace() throws Exception {
        Files.createDirectories(workspace.resolve("src"));

        assertEquals("src/App.java", validate("src/./App.java"));
    }

    @Test
    void rejectsTraversalAndAbsolutePaths() {
        assertInvalid("../secret.txt");
        assertInvalid(workspace.getParent().resolve("secret.txt").toString());
    }

    @Test
    void rejectsPathsThatEscapeThroughASymbolicLink() throws Exception {
        Path outside = Files.createTempDirectory("loopra-outside");
        Path link = workspace.resolve("linked");
        try {
            try {
                Files.createSymbolicLink(link, outside);
            } catch (UnsupportedOperationException | java.nio.file.FileSystemException e) {
                return;
            }

            assertInvalid("linked/secret.txt");
        } finally {
            Files.deleteIfExists(link);
            Files.deleteIfExists(outside);
        }
    }

    @Test
    void drainsStdoutAndStderrConcurrently() throws Exception {
        Method runGit = GitService.class.getDeclaredMethod("runGit", File.class, String[].class);
        runGit.setAccessible(true);

        String[] command = System.getProperty("os.name").toLowerCase().contains("win")
                ? new String[]{"powershell", "-NoProfile", "-Command",
                        "$errorText = 'e' * 131072; [Console]::Error.Write($errorText); [Console]::Out.Write('ok')"}
                : new String[]{"sh", "-c",
                        "head -c 131072 /dev/zero | tr '\\0' 'e' >&2; printf ok"};
        ProcessResult result = (ProcessResult) runGit.invoke(
                service, workspace.toFile(), (Object) command);

        assertEquals(0, result.exitCode);
        assertEquals("ok", result.stdout);
        assertEquals(131072, result.stderr.length());
    }

    private String validate(String path) throws Exception {
        Method validatePath = GitService.class.getDeclaredMethod("validatePath", File.class, String.class);
        validatePath.setAccessible(true);
        return (String) validatePath.invoke(service, workspace.toFile(), path);
    }

    private void assertInvalid(String path) {
        InvocationTargetException error = assertThrows(InvocationTargetException.class, () -> validate(path));
        assertInstanceOf(ServiceException.class, error.getCause());
    }
}

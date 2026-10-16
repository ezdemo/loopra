package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceOpenServiceTest {
    @TempDir Path temporary;
    private static final String HASH = "123456abcdef";

    private static class LaunchedProcess extends Process {
        public OutputStream getOutputStream() { return OutputStream.nullOutputStream(); }
        public InputStream getInputStream() { return InputStream.nullInputStream(); }
        public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        public int waitFor() { return 0; }
        public boolean waitFor(long time, TimeUnit unit) { return true; }
        public int exitValue() { return 0; }
        public void destroy() { }
    }

    @Test
    void opensTheResolvedProjectRatherThanAcceptingAnArbitraryClientPath() throws Exception {
        Path project = Files.createDirectory(temporary.resolve("工作 项目 & $test"));
        AtomicReference<ProcessBuilder> launched = new AtomicReference<>();
        var service = new WorkspaceOpenService(hash -> { assertEquals(HASH, hash); return project.toString(); }, Path::of,
                builder -> { launched.set(builder); return new LaunchedProcess(); }, "Windows 11");
        assertEquals(project.toString(), service.open(HASH, "folder"));
        assertEquals(List.of("explorer.exe", project.toString()), launched.get().command());
        assertEquals(project.toFile(), launched.get().directory());
        assertThrows(ServiceException.class, () -> service.open(project.toString(), "folder"));
    }

    @Test
    void powershellStartsAVisibleWindowWithItsWorkingDirectoryPassedAsData() throws Exception {
        Path project = Files.createDirectory(temporary.resolve("项目 '$() & spaces"));
        AtomicReference<ProcessBuilder> launched = new AtomicReference<>();
        var service = new WorkspaceOpenService(hash -> project.toString(), Path::of,
                builder -> { launched.set(builder); return new LaunchedProcess(); }, "Windows 11");
        service.open(HASH, "powershell");
        ProcessBuilder builder = launched.get();
        assertEquals(project.toString(), builder.environment().get("LOOPRA_OPEN_DIRECTORY"));
        assertEquals("pwsh.exe", builder.environment().get("LOOPRA_OPEN_EXECUTABLE"));
        String script = builder.command().get(builder.command().size() - 1);
        assertTrue(script.contains("-WindowStyle Normal"));
        assertTrue(script.contains("-WorkingDirectory $env:LOOPRA_OPEN_DIRECTORY"));
        assertFalse(script.contains(project.toString()));
    }

    @Test
    void gitBashAndBashOpenAtTheProjectDirectoryOnWindows() {
        AtomicReference<ProcessBuilder> launched = new AtomicReference<>();
        var service = new WorkspaceOpenService(hash -> temporary.toString(), Path::of,
                builder -> { launched.set(builder); return new LaunchedProcess(); }, "Windows 11");
        for (String app : List.of("git-bash", "bash")) {
            service.open(HASH, app);
            assertEquals(List.of("git-bash.exe", "--cd=" + temporary), launched.get().command());
            assertEquals(temporary.toFile(), launched.get().directory());
        }
    }

    @Test
    void missingProgramsUnknownProjectsAndUnsupportedApplicationsDoNotLaunchAnything() {
        var service = new WorkspaceOpenService(hash -> hash.equals(HASH) ? temporary.toString() : null, name -> null,
                builder -> { fail("must not launch"); return null; }, "Windows 11");
        assertTrue(assertThrows(ServiceException.class, () -> service.open(HASH, "git-bash")).getMessage().contains("Git for Windows"));
        assertThrows(ServiceException.class, () -> service.open("000000000000", "folder"));
        assertThrows(ServiceException.class, () -> service.open(HASH, "arbitrary-command"));
        assertThrows(ServiceException.class, () -> service.open(HASH, null));
        assertThrows(ServiceException.class, () -> service.open(null, "folder"));
    }

    @Test
    void removedProjectDirectoriesCannotBeOpened() {
        var service = new WorkspaceOpenService(hash -> temporary.resolve("missing").toString(), Path::of,
                builder -> { fail("must not launch"); return null; }, "Windows 11");
        assertTrue(assertThrows(ServiceException.class, () -> service.open(HASH, "folder")).getMessage().contains("不存在"));
    }

    @Test
    void linuxBashUsesADesktopTerminalRootedAtTheProject() {
        AtomicReference<ProcessBuilder> launched = new AtomicReference<>();
        Function<String, Path> installed = name -> List.of("bash", "gnome-terminal").contains(name) ? Path.of("/usr/bin", name) : null;
        var service = new WorkspaceOpenService(hash -> temporary.toString(), installed,
                builder -> { launched.set(builder); return new LaunchedProcess(); }, "Linux");
        service.open(HASH, "bash");
        assertEquals(List.of(Path.of("/usr/bin/gnome-terminal").toString(), "--working-directory=" + temporary, "--", Path.of("/usr/bin/bash").toString()), launched.get().command());
        assertEquals(temporary.toFile(), launched.get().directory());
        assertThrows(ServiceException.class, () -> service.open(HASH, "git-bash"));
    }

    @Test
    void macBashPassesPathsAsAppleScriptArgumentsRatherThanEmbeddingThemInCode() {
        AtomicReference<ProcessBuilder> launched = new AtomicReference<>();
        var service = new WorkspaceOpenService(hash -> temporary.toString(), Path::of,
                builder -> { launched.set(builder); return new LaunchedProcess(); }, "Mac OS X");
        service.open(HASH, "bash");
        List<String> command = launched.get().command();
        assertEquals("osascript", command.get(0));
        assertFalse(command.get(2).contains(temporary.toString()));
        assertEquals(temporary.toString(), command.get(3));
        assertTrue(command.get(2).contains("quoted form"));
    }

    @Test
    void failedNativeLaunchesAreReported() {
        var service = new WorkspaceOpenService(hash -> temporary.toString(), Path::of,
                builder -> new LaunchedProcess() { public int exitValue() { return 2; } }, "Windows 11");
        assertThrows(ServiceException.class, () -> service.open(HASH, "powershell"));
    }

    /** Reports exactly the named programs as present, so availability can be probed per platform. */
    private static Function<String, Path> only(String... present) {
        List<String> available = List.of(present);
        return name -> available.contains(name) ? Path.of("/usr/bin", name) : null;
    }

    private static WorkspaceOpenService service(String os, String... present) {
        return new WorkspaceOpenService(hash -> null, only(present), builder -> new LaunchedProcess(), os);
    }

    @Test
    void macOffersNeitherGitBashNorPowerShellUnlessPwshIsInstalled() {
        assertEquals(List.of("folder", "bash", "terminal"), service("Mac OS X", "bash").availableApplications());
        assertEquals(List.of("folder", "powershell", "bash", "terminal"),
                service("Mac OS X", "bash", "pwsh").availableApplications());
    }

    @Test
    void windowsOnlyOffersTheProgramsItCanFind() {
        assertEquals(List.of("folder", "git-bash", "bash", "powershell", "terminal"),
                service("Windows 11", "git-bash.exe", "powershell.exe").availableApplications());
        assertEquals(List.of("folder"), service("Windows 11").availableApplications());
    }

    @Test
    void linuxNeedsBothAShellAndADesktopTerminal() {
        assertEquals(List.of("folder"), service("Linux", "bash").availableApplications());
        assertEquals(List.of("folder", "bash", "terminal"),
                service("Linux", "bash", "xfce4-terminal").availableApplications());
    }
}

package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class DirectoryPickerServiceTest {
    @TempDir Path directory;

    private static final class FinishedProcess extends Process {
        private final boolean finished;
        boolean destroyed;
        FinishedProcess(boolean finished) { this.finished = finished; }
        public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        public InputStream getErrorStream() { return new ByteArrayInputStream(new byte[0]); }
        public int waitFor() { return 0; }
        public boolean waitFor(long timeout, TimeUnit unit) { return finished || destroyed; }
        public int exitValue() { return 0; }
        public boolean isAlive() { return !finished && !destroyed; }
        public void destroy() { destroyed = true; }
        public Process destroyForcibly() { destroyed = true; return this; }
    }

    @Test
    void selectedDirectoriesReturnAbsolutePathsAndTemporaryFilesAreRemoved() {
        AtomicReference<Path> resultFile = new AtomicReference<>();
        DirectoryPickerService service = new DirectoryPickerService(builder -> {
            List<String> command = builder.command();
            int helper = command.indexOf("site.sorghum.loopra.web.service.DirectoryPickerMain");
            Path result = Path.of(command.get(helper + 1));
            resultFile.set(result);
            assertEquals(directory.toString(), command.get(helper + 2));
            assertTrue(command.get(command.indexOf("-cp") + 1).contains("swt.jar"));
            Files.writeString(result, directory.toString());
            return new FinishedProcess(true);
        }, Duration.ofSeconds(1));
        assertEquals(directory.toAbsolutePath().normalize().toString(), service.pickDirectory(directory.toString()));
        assertFalse(Files.exists(resultFile.get().getParent()));
    }

    @Test
    void headlessServerStillStartsAnIndependentDesktopPicker() {
        String previous = System.getProperty("java.awt.headless");
        try {
            System.setProperty("java.awt.headless", "true");
            DirectoryPickerService service = new DirectoryPickerService(builder -> {
                List<String> command = builder.command();
                assertTrue(command.contains("-Djava.awt.headless=false"));
                int helper = command.indexOf("site.sorghum.loopra.web.service.DirectoryPickerMain");
                Files.writeString(Path.of(command.get(helper + 1)), directory.toString());
                return new FinishedProcess(true);
            }, Duration.ofSeconds(1));
            assertEquals(directory.toAbsolutePath().normalize().toString(), service.pickDirectory(null));
            assertEquals("true", System.getProperty("java.awt.headless"));
        } finally {
            if (previous == null) System.clearProperty("java.awt.headless");
            else System.setProperty("java.awt.headless", previous);
        }
    }

    @Test
    void cancellationReturnsEmptyAndDoesNotPreventAnotherSelection() {
        DirectoryPickerService service = new DirectoryPickerService(builder -> {
            int helper = builder.command().indexOf("site.sorghum.loopra.web.service.DirectoryPickerMain");
            Files.writeString(Path.of(builder.command().get(helper + 1)), "");
            return new FinishedProcess(true);
        }, Duration.ofSeconds(1));
        assertEquals("", service.pickDirectory(null));
        assertEquals("", service.pickDirectory(null));
    }

    @Test
    void timeoutClosesTheNativeProcessAndReleasesThePicker() {
        FinishedProcess process = new FinishedProcess(false);
        DirectoryPickerService service = new DirectoryPickerService(builder -> process, Duration.ZERO);
        assertTrue(assertThrows(ServiceException.class, () -> service.pickDirectory(null)).getMessage().contains("超时"));
        assertTrue(process.destroyed);
    }

    @Test
    void concurrentDialogRequestsAreRejected() {
        AtomicReference<DirectoryPickerService> holder = new AtomicReference<>();
        DirectoryPickerService service = new DirectoryPickerService(builder -> {
            assertTrue(assertThrows(ServiceException.class, () -> holder.get().pickDirectory(null)).getMessage().contains("已打开"));
            int helper = builder.command().indexOf("site.sorghum.loopra.web.service.DirectoryPickerMain");
            Files.writeString(Path.of(builder.command().get(helper + 1)), "");
            return new FinishedProcess(true);
        }, Duration.ofSeconds(1));
        holder.set(service);
        assertEquals("", service.pickDirectory(null));
    }

    @Test
    void selectsRuntimeByOsAndArchitecture() {
        assertEquals("win32-x86_64", DirectoryPickerService.platform("Windows 11", "amd64"));
        assertEquals("linux-aarch64", DirectoryPickerService.platform("Linux", "arm64"));
        assertEquals("macos-aarch64", DirectoryPickerService.platform("Mac OS X", "aarch64"));
        assertThrows(ServiceException.class, () -> DirectoryPickerService.platform("Windows 11", "aarch64"));
        assertThrows(ServiceException.class, () -> DirectoryPickerService.platform("Linux", "x86"));
    }
}

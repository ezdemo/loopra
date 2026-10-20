package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.VersionUpdateDTO;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VersionUpdateServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void startsDesktopWindowsUpdaterWithoutStoppingTheCurrentService() throws Exception {
        AtomicReference<ProcessBuilder> started = new AtomicReference<>();
        VersionUpdateService service = new VersionUpdateService(builder -> {
            started.set(builder);
            return new TestProcess();
        }, "Windows 11", tempDir,
                Path.of("C:/Users/demo/.loopra-gui/bin/loopra-web.jar"));

        VersionUpdateDTO result = service.start("normal");

        assertTrue(result.running());
        assertEquals("starting", result.state());
        assertEquals("桌面端核心服务", result.target());
        assertTrue(result.message().contains("正在准备"));
        assertNotNull(started.get());
        assertEquals("powershell.exe", started.get().command().get(0));
        assertTrue(started.get().environment().get("LOOPRA_UPDATE_SETUP_URL").endsWith("/setup-gui.ps1"));

        Path script = Path.of(started.get().command().get(started.get().command().size() - 1));
        String content = Files.readString(script);
        assertTrue(content.contains("Invoke-WebRequest"));
        assertFalse(content.contains("Stop-Process"));
        assertFalse(content.contains("Start-Process"));
    }

    @Test
    void usesTheSelectedMirrorForUnixInstallers() throws Exception {
        AtomicReference<ProcessBuilder> started = new AtomicReference<>();
        VersionUpdateService service = new VersionUpdateService(builder -> {
            started.set(builder);
            return new TestProcess();
        }, "Linux", tempDir,
                Path.of("/home/demo/.loopra/bin/loopra-web.jar"));

        VersionUpdateDTO result = service.start("https://wget.la/");

        assertEquals("核心服务", result.target());
        assertEquals("bash", started.get().command().get(0));
        assertEquals("https://wget.la", started.get().environment().get("LOOPRA_MIRROR"));
        assertTrue(started.get().environment().get("LOOPRA_UPDATE_SETUP_URL")
                .startsWith("https://wget.la/https://raw.githubusercontent.com/"));
        String content = Files.readString(Path.of(started.get().command().get(started.get().command().size() - 1)));
        assertTrue(content.contains("bash \"$setup_file\""));
        assertFalse(content.contains("kill \"$parent_pid\""));
    }

    @Test
    void rejectsUnknownMirrorHosts() throws Exception {
        AtomicReference<ProcessBuilder> started = new AtomicReference<>();
        VersionUpdateService service = new VersionUpdateService(builder -> {
            started.set(builder);
            return new TestProcess();
        }, "Linux", tempDir, null);

        assertThrows(ServiceException.class, () -> service.start("https://example.com/"));
    }

    @Test
    void exposesLogsAndCanStopTheRunningUpdater() throws Exception {
        AtomicReference<TestProcess> process = new AtomicReference<>();
        VersionUpdateService service = new VersionUpdateService(builder -> {
            process.set(new TestProcess());
            return process.get();
        }, "Windows 11", tempDir, null);

        VersionUpdateDTO started = service.start("normal");
        Files.writeString(Path.of(started.logFile()), "[Loopra] 正在下载并安装新版本\n");

        VersionUpdateDTO status = service.status();
        assertTrue(status.running());
        assertTrue(status.log().contains("正在下载并安装新版本"));

        VersionUpdateDTO stopped = service.stop();
        assertFalse(stopped.running());
        assertEquals("stopped", stopped.state());
        assertTrue(stopped.message().contains("已停止"));
        assertTrue(stopped.log().contains("更新已停止"));
        assertFalse(process.get().isAlive());
        assertEquals("stopped", service.status().state());
    }

    private static final class TestProcess extends Process {
        private boolean alive = true;
        private int exitCode = 143;

        @Override
        public OutputStream getOutputStream() {
            return OutputStream.nullOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public InputStream getErrorStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public synchronized int waitFor() throws InterruptedException {
            while (alive) wait();
            return exitCode;
        }

        @Override
        public synchronized boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
            if (!alive) return true;
            long deadline = System.nanoTime() + unit.toNanos(timeout);
            while (alive) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) return false;
                TimeUnit.NANOSECONDS.timedWait(this, remaining);
            }
            return true;
        }

        @Override
        public synchronized int exitValue() {
            if (alive) throw new IllegalThreadStateException("process is still running");
            return exitCode;
        }

        @Override
        public synchronized void destroy() {
            alive = false;
            notifyAll();
        }

        @Override
        public synchronized boolean isAlive() {
            return alive;
        }
    }
}

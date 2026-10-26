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
    void rejectsDesktopCoreUpdatesBeforeWritingFilesOrStartingProcesses() {
        for (String os : new String[]{"Windows 11", "Linux", "Mac OS X"}) {
            VersionUpdateService service = new VersionUpdateService(builder -> {
                throw new AssertionError("Desktop core must never launch an updater");
            }, os, tempDir, Path.of("/home/demo/.loopra-gui/bin/loopra-web.jar"));

            ServiceException error = assertThrows(ServiceException.class, () -> service.start("normal"));

            assertTrue(error.getMessage().contains("不能单独更新核心服务"));
            assertFalse(Files.exists(tempDir.resolve(".loopra/updates")));
            assertFalse(service.status().running());
        }
    }

    @Test
    void startsStandaloneWindowsUpdaterWithoutStoppingTheCurrentService() throws Exception {
        AtomicReference<ProcessBuilder> started = new AtomicReference<>();
        VersionUpdateService service = new VersionUpdateService(builder -> {
            started.set(builder);
            return new TestProcess();
        }, "Windows 11", tempDir,
                Path.of("C:/Users/demo/.loopra/bin/loopra-web.jar"));

        VersionUpdateDTO result = service.start("normal");

        assertTrue(result.running());
        assertEquals("starting", result.state());
        assertEquals("核心服务", result.target());
        assertTrue(result.message().contains("正在准备"));
        assertNotNull(started.get());
        assertEquals("powershell.exe", started.get().command().get(0));
        assertEquals("https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.ps1",
                started.get().environment().get("LOOPRA_UPDATE_SETUP_URL"));
        assertFalse(started.get().environment().containsKey("LOOPRA_MIRROR"));

        Path script = Path.of(started.get().command().get(started.get().command().size() - 1));
        byte[] scriptBytes = Files.readAllBytes(script);
        String content = Files.readString(script);
        assertEquals(0xEF, Byte.toUnsignedInt(scriptBytes[0]));
        assertEquals(0xBB, Byte.toUnsignedInt(scriptBytes[1]));
        assertEquals(0xBF, Byte.toUnsignedInt(scriptBytes[2]));
        assertTrue(content.contains("Invoke-WebRequest"));
        assertTrue(content.contains("Add-Content -LiteralPath $logFile -Encoding UTF8"));
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
        assertEquals("https://wget.la/", started.get().environment().get("LOOPRA_MIRROR"));
        assertEquals("https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.sh",
                started.get().environment().get("LOOPRA_UPDATE_SETUP_URL"));
        String content = Files.readString(Path.of(started.get().command().get(started.get().command().size() - 1)));
        assertTrue(content.contains("bash \"$setup_file\""));
        assertFalse(content.contains("kill \"$parent_pid\""));
    }

    @Test
    void passesMirrorsThroughTheEnvironmentOnEveryPlatform() {
        for (String os : new String[]{"Windows 11", "Linux", "Mac OS X"}) {
            for (String source : new String[]{"mirror", "https://gh-proxy.org/", "https://ghfast.top"}) {
                AtomicReference<ProcessBuilder> started = new AtomicReference<>();
                VersionUpdateService service = new VersionUpdateService(builder -> {
                    started.set(builder);
                    return new TestProcess();
                }, os, tempDir, null);

                service.start(source);

                String expectedMirror = source.equals("https://ghfast.top")
                        ? "https://ghfast.top/" : "https://gh-proxy.org/";
                assertEquals(expectedMirror, started.get().environment().get("LOOPRA_MIRROR"));
                String extension = os.startsWith("Windows") ? "ps1" : "sh";
                assertEquals("https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup." + extension,
                        started.get().environment().get("LOOPRA_UPDATE_SETUP_URL"));
                assertFalse(started.get().environment().containsKey("LOOPRA_UPDATE_MIRROR"));
            }
        }
    }

    @Test
    void normalizesMirrorRootsAndRejectsInvalidMirrorRoutes() {
        assertEquals("https://gh-proxy.org/", VersionUpdateService.normalizeMirror("mirror"));
        assertEquals("https://ghfast.top/", VersionUpdateService.normalizeMirror("https://GHFAST.TOP"));
        for (String source : new String[]{"https://ghfast.top/other", "https://ghfast.top/?query=1",
                "https://ghfast.top/#fragment", "https://ghfast.top:444/", "http://ghfast.top/"}) {
            assertThrows(ServiceException.class, () -> VersionUpdateService.normalizeMirror(source));
        }
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

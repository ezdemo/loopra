package site.sorghum.loopra.testing;

import org.junit.platform.launcher.LauncherSession;
import org.junit.platform.launcher.LauncherSessionListener;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

/** Isolate all default stores before test discovery can initialize static paths (Maven and IDE). */
public final class IsolatedTestHome implements LauncherSessionListener {
    private String originalHome;
    private Path testHome;

    @Override
    public void launcherSessionOpened(LauncherSession session) {
        originalHome = System.getProperty("user.home");
        try {
            testHome = Files.createTempDirectory("loopra-test-home-").toRealPath();
        } catch (IOException error) {
            // Fail before discovery rather than risk falling back to the user's data.
            throw new UncheckedIOException("Cannot create isolated Loopra test home", error);
        }
        System.setProperty("user.home", testHome.toString());
        System.setProperty("loopra.test.home", testHome.toString());
        try {
            // Individual config tests temporarily change user.home. Pin static default stores
            // now so their lifetime does not depend on which of those tests runs first.
            Class.forName("site.sorghum.loopra.bin.project.ProjectRegistry");
            Class.forName("site.sorghum.loopra.bin.session.JsonlSessionStore");
        } catch (ClassNotFoundException error) {
            throw new IllegalStateException("Cannot initialize isolated Loopra stores", error);
        }
    }

    @Override
    public void launcherSessionClosed(LauncherSession session) {
        if (originalHome == null) System.clearProperty("user.home");
        else System.setProperty("user.home", originalHome);
        System.clearProperty("loopra.test.home");
        if (testHome == null) return;
        // Only remove the fresh directory created by this listener. Do not follow symlinks.
        try (var paths = Files.walk(testHome)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                try { Files.deleteIfExists(path); }
                catch (IOException error) {
                    System.err.println("Loopra test cleanup retained " + path + ": " + error.getMessage());
                }
            }
        } catch (IOException error) {
            System.err.println("Loopra test cleanup retained " + testHome + ": " + error.getMessage());
        }
    }
}

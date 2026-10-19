package site.sorghum.loopra.bin.agent.hitl;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.Assumptions;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceFileOperationsTest {
    @TempDir Path temporary;

    @Test
    void localNewFilesAndAbsolutePathsAreAllowedButEscapesAreNot() throws Exception {
        Path root = Files.createDirectories(temporary.resolve("workspace"));
        assertTrue(WorkspaceFileOperations.isWithin(root, root, "src/new/file.txt"));
        assertTrue(WorkspaceFileOperations.isWithin(root, root, root.resolve("new.txt").toString()));
        assertFalse(WorkspaceFileOperations.isWithin(root, root, "../outside.txt"));
        assertFalse(WorkspaceFileOperations.isWithin(root, root, temporary.resolve("workspace-other/file.txt").toString()));
        assertFalse(WorkspaceFileOperations.isWithin(root, root, "@mount/file.txt"));
        assertFalse(WorkspaceFileOperations.isWithin(root, root, "~/file.txt"));
        assertFalse(WorkspaceFileOperations.isWithin(root, root, ""));
    }

    @Test
    void symlinksAndParentTraversalResolveBeforeCheckingWorkspaceBoundary() throws Exception {
        Path root = Files.createDirectories(temporary.resolve("workspace"));
        Path outside = Files.createDirectories(temporary.resolve("outside/child"));
        try {
            Files.createSymbolicLink(root.resolve("link"), outside);
        } catch (IOException | UnsupportedOperationException | SecurityException exception) {
            Assumptions.abort("Symbolic links unavailable: " + exception.getMessage());
        }
        assertFalse(WorkspaceFileOperations.isWithin(root, root, "link/new.txt"));
        // Windows 在解析 reparse point 之前就按词法折叠 ".."，所以 link/../new.txt 落在工作区内；
        // POSIX 先解析符号链接，同一路径指向工作区外。这里断言各平台的真实语义。
        assertEquals(isWindows(), WorkspaceFileOperations.isWithin(root, root, "link/../new.txt"),
                "link/.. 的解析顺序随平台不同（Windows 词法折叠，POSIX 先解析符号链接）");
        assertTrue(WorkspaceFileOperations.isWithin(root, root, "missing/../new.txt"));
    }

    private static boolean isWindows() {
        return System.getProperty("os.name").toLowerCase().contains("win");
    }
}

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
        assertFalse(WorkspaceFileOperations.isWithin(root, root, "link/../new.txt"));
        assertTrue(WorkspaceFileOperations.isWithin(root, root, "missing/../new.txt"));
    }
}

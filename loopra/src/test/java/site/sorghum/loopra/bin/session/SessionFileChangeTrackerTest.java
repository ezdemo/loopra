package site.sorghum.loopra.bin.session;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.FileChange;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionFileChangeTrackerTest {
    @TempDir
    Path workspace;

    @Test
    void reportsNetChangeForRepeatedEditsOfTheSameFile() {
        SessionFileChangeTracker.beginTurn(workspace, "session-a");
        SessionFileChangeTracker.bind(workspace, "session-a");
        try {
            SessionFileChangeTracker.record("src/App.java", "one\ntwo\n", "one\ntwo\nthree\n", false);
            SessionFileChangeTracker.record("src/App.java", "one\ntwo\nthree\n", "one\nthree\n", false);
        } finally {
            SessionFileChangeTracker.clearBinding();
        }

        List<FileChange> changes =
                SessionFileChangeTracker.drain(workspace, "session-a");

        assertEquals(1, changes.size());
        assertEquals("src/App.java", changes.get(0).path());
        assertEquals(1, changes.get(0).additions());
        assertEquals(1, changes.get(0).deletions());
    }

    @Test
    void recordsAFinalNewlineOnlyChangeAsAReversibleDiff() {
        SessionFileChangeTracker.beginTurn(workspace, "session-a");
        SessionFileChangeTracker.bind(workspace, "session-a");
        try {
            SessionFileChangeTracker.record("src/App.java", "one", "one\n", false);
        } finally {
            SessionFileChangeTracker.clearBinding();
        }

        List<FileChange> changes = SessionFileChangeTracker.drain(workspace, "session-a");

        assertEquals(1, changes.size());
        assertEquals(1, changes.get(0).additions());
        assertEquals(1, changes.get(0).deletions());
        assertTrue(changes.get(0).diff().contains("\\ No newline at end of file"));
    }

    @Test
    void reportsOnlyChangedLinesForLargeFilesWithScatteredEdits() {
        String before = largeFile(null, null);
        String after = largeFile(500, 1600);
        SessionFileChangeTracker.beginTurn(workspace, "session-a");
        SessionFileChangeTracker.bind(workspace, "session-a");
        try {
            SessionFileChangeTracker.record("src/Large.java", before, after, false);
        } finally {
            SessionFileChangeTracker.clearBinding();
        }

        List<FileChange> changes = SessionFileChangeTracker.drain(workspace, "session-a");

        assertEquals(1, changes.size());
        assertEquals(2, changes.get(0).additions());
        assertEquals(2, changes.get(0).deletions());
    }

    @Test
    void groupsChangesByToolCallAndKeepsCreationForNewFiles() {
        SessionFileChangeTracker.beginTurn(workspace, "session-a");
        SessionFileChangeTracker.bind(workspace, "session-a");
        try {
            SessionFileChangeTracker.beginTool();
            SessionFileChangeTracker.record("src/New.java", "", "one\n", true);
            SessionFileChangeTracker.record("src/New.java", "one\n", "one\ntwo\n", false);
            SessionFileChangeTracker.record("src/Other.java", "old\n", "new\n", false);
            List<SessionFileChangeTracker.ToolChange> first = SessionFileChangeTracker.endTool();

            SessionFileChangeTracker.beginTool();
            SessionFileChangeTracker.record("src/New.java", "one\ntwo\n", "one\n", false);
            List<SessionFileChangeTracker.ToolChange> second = SessionFileChangeTracker.endTool();

            assertEquals(List.of(
                    new SessionFileChangeTracker.ToolChange("src/New.java", "", "one\ntwo\n", true),
                    new SessionFileChangeTracker.ToolChange("src/Other.java", "old\n", "new\n", false)), first);
            assertEquals(List.of(
                    new SessionFileChangeTracker.ToolChange("src/New.java", "one\ntwo\n", "one\n", false)), second);
        } finally {
            SessionFileChangeTracker.clearBinding();
        }
        // Session-level tracking stays independent and still sees the net change of the turn.
        List<FileChange> changes = SessionFileChangeTracker.drain(workspace, "session-a");
        assertEquals(2, changes.size());
    }

    private static String largeFile(Integer firstChange, Integer secondChange) {
        StringBuilder content = new StringBuilder();
        for (int index = 0; index < 2100; index++) {
            boolean changed = Integer.valueOf(index).equals(firstChange) || Integer.valueOf(index).equals(secondChange);
            content.append(changed ? "changed-" : "line-").append(index).append('\n');
        }
        return content.toString();
    }
}

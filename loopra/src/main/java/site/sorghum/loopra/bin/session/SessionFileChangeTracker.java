package site.sorghum.loopra.bin.session;

import site.sorghum.loopra.bin.agent.model.FileChange;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
  * 收集单个聊天回合内 TerminalTalent 写入/编辑调用产生的净文本变更。
 */
public final class SessionFileChangeTracker {
    private static final ThreadLocal<String> CURRENT_SCOPE = new ThreadLocal<>();
    private static final ConcurrentHashMap<String, ConcurrentHashMap<String, ChangeSnapshot>> CHANGES =
            new ConcurrentHashMap<>();

    private SessionFileChangeTracker() {
    }

    public static void beginTurn(Path workspace, String sessionId) {
        String scope = scope(workspace, sessionId);
        CHANGES.remove(scope);
    }

    public static void bind(Path workspace, String sessionId) {
        CURRENT_SCOPE.set(scope(workspace, sessionId));
    }

    public static void clearBinding() {
        CURRENT_SCOPE.remove();
    }

    public static void record(String filePath, String before, String after, boolean created) {
        String scope = CURRENT_SCOPE.get();
        if (scope == null || before.equals(after)) return;

        CHANGES.computeIfAbsent(scope, ignored -> new ConcurrentHashMap<>())
                .compute(filePath, (ignored, existing) -> existing == null
                        ? new ChangeSnapshot(before, after, created)
                        : existing.withAfter(after));
    }

    public static List<FileChange> drain(Path workspace, String sessionId) {
        Map<String, ChangeSnapshot> changes = CHANGES.remove(scope(workspace, sessionId));
        if (changes == null || changes.isEmpty()) return List.of();

        List<FileChange> result = new ArrayList<>();
        changes.forEach((path, snapshot) -> {
            DiffSnapshot diff = DiffSnapshot.of(path, snapshot.before(), snapshot.after());
            if (diff.stats().additions() > 0 || diff.stats().deletions() > 0 || !snapshot.before().equals(snapshot.after())) {
                result.add(new FileChange(path, diff.stats().additions(), diff.stats().deletions(), snapshot.created(), diff.unified()));
            }
        });
        result.sort(Comparator.comparing(FileChange::path));
        return result;
    }

    private static String scope(Path workspace, String sessionId) {
        String root = workspace == null ? "" : workspace.toAbsolutePath().normalize().toString();
        return root + "::" + (sessionId == null ? "default" : sessionId);
    }

    private record ChangeSnapshot(String before, String after, boolean created) {
        ChangeSnapshot withAfter(String value) {
            return new ChangeSnapshot(before, value, created);
        }
    }

    private static final long MAX_EXACT_LCS_COMPARISONS = 16_000_000L;

    private record LineStats(int additions, int deletions) {
    }

    private record LineMatch(int oldIndex, int newIndex) {
    }

    private record DiffSnapshot(LineStats stats, String unified) {
        private static DiffSnapshot of(String path, String before, String after) {
            String[] oldLines = lines(before);
            String[] newLines = lines(after);
            boolean oldMissingFinalNewline = hasLinesWithoutFinalNewline(before, oldLines);
            boolean newMissingFinalNewline = hasLinesWithoutFinalNewline(after, newLines);
            StringBuilder out = new StringBuilder("--- a/").append(path).append('\n')
                    .append("+++ b/").append(path).append('\n')
                    .append("@@ -1,").append(oldLines.length).append(" +1,").append(newLines.length).append(" @@\n");
            if ((long) oldLines.length * newLines.length > MAX_EXACT_LCS_COMPARISONS) {
                appendWholeFileReplacement(out, oldLines, newLines, oldMissingFinalNewline, newMissingFinalNewline);
                return new DiffSnapshot(new LineStats(newLines.length, oldLines.length), out.toString());
            }

            List<LineMatch> matches = new ArrayList<>();
            collectLcsMatches(oldLines, 0, oldLines.length, newLines, 0, newLines.length, matches);
            int additions = 0, deletions = 0, oldIndex = 0, newIndex = 0;
            for (LineMatch match : matches) {
                while (oldIndex < match.oldIndex()) {
                    appendLine(out, '-', oldLines[oldIndex], oldIndex == oldLines.length - 1 && oldMissingFinalNewline);
                    oldIndex++;
                    deletions++;
                }
                while (newIndex < match.newIndex()) {
                    appendLine(out, '+', newLines[newIndex], newIndex == newLines.length - 1 && newMissingFinalNewline);
                    newIndex++;
                    additions++;
                }
                boolean finalNewlineChanged = oldIndex == oldLines.length - 1 && newIndex == newLines.length - 1
                        && oldMissingFinalNewline != newMissingFinalNewline;
                if (finalNewlineChanged) {
                    appendLine(out, '-', oldLines[oldIndex], oldMissingFinalNewline);
                    appendLine(out, '+', newLines[newIndex], newMissingFinalNewline);
                    additions++;
                    deletions++;
                } else {
                    boolean missingFinalNewline = (oldIndex == oldLines.length - 1 && oldMissingFinalNewline)
                            || (newIndex == newLines.length - 1 && newMissingFinalNewline);
                    appendLine(out, ' ', oldLines[oldIndex], missingFinalNewline);
                }
                oldIndex++;
                newIndex++;
            }
            while (oldIndex < oldLines.length) {
                appendLine(out, '-', oldLines[oldIndex], oldIndex == oldLines.length - 1 && oldMissingFinalNewline);
                oldIndex++;
                deletions++;
            }
            while (newIndex < newLines.length) {
                appendLine(out, '+', newLines[newIndex], newIndex == newLines.length - 1 && newMissingFinalNewline);
                newIndex++;
                additions++;
            }
            return new DiffSnapshot(new LineStats(additions, deletions), out.toString());
        }

        private static void appendWholeFileReplacement(StringBuilder out, String[] oldLines, String[] newLines,
                                                       boolean oldMissingFinalNewline, boolean newMissingFinalNewline) {
            for (int index = 0; index < oldLines.length; index++) {
                appendLine(out, '-', oldLines[index], index == oldLines.length - 1 && oldMissingFinalNewline);
            }
            for (int index = 0; index < newLines.length; index++) {
                appendLine(out, '+', newLines[index], index == newLines.length - 1 && newMissingFinalNewline);
            }
        }

        private static void collectLcsMatches(String[] oldLines, int oldStart, int oldEnd,
                                              String[] newLines, int newStart, int newEnd,
                                              List<LineMatch> matches) {
            int oldLength = oldEnd - oldStart;
            int newLength = newEnd - newStart;
            if (oldLength == 0 || newLength == 0) return;
            if (oldLength == 1) {
                for (int newIndex = newStart; newIndex < newEnd; newIndex++) {
                    if (oldLines[oldStart].equals(newLines[newIndex])) {
                        matches.add(new LineMatch(oldStart, newIndex));
                        return;
                    }
                }
                return;
            }

            int oldMiddle = oldStart + oldLength / 2;
            int[] leftLengths = lcsPrefixLengths(oldLines, oldStart, oldMiddle, newLines, newStart, newEnd);
            int[] rightLengths = lcsSuffixLengths(oldLines, oldMiddle, oldEnd, newLines, newStart, newEnd);
            int splitOffset = 0;
            int bestLength = -1;
            for (int offset = 0; offset <= newLength; offset++) {
                int length = leftLengths[offset] + rightLengths[offset];
                if (length > bestLength) {
                    bestLength = length;
                    splitOffset = offset;
                }
            }
            int newMiddle = newStart + splitOffset;
            collectLcsMatches(oldLines, oldStart, oldMiddle, newLines, newStart, newMiddle, matches);
            collectLcsMatches(oldLines, oldMiddle, oldEnd, newLines, newMiddle, newEnd, matches);
        }

        private static int[] lcsPrefixLengths(String[] oldLines, int oldStart, int oldEnd,
                                              String[] newLines, int newStart, int newEnd) {
            int newLength = newEnd - newStart;
            int[] lengths = new int[newLength + 1];
            for (int oldIndex = oldStart; oldIndex < oldEnd; oldIndex++) {
                int diagonal = 0;
                for (int offset = 1; offset <= newLength; offset++) {
                    int previousRow = lengths[offset];
                    if (oldLines[oldIndex].equals(newLines[newStart + offset - 1])) {
                        lengths[offset] = diagonal + 1;
                    } else {
                        lengths[offset] = Math.max(lengths[offset], lengths[offset - 1]);
                    }
                    diagonal = previousRow;
                }
            }
            return lengths;
        }

        private static int[] lcsSuffixLengths(String[] oldLines, int oldStart, int oldEnd,
                                              String[] newLines, int newStart, int newEnd) {
            int newLength = newEnd - newStart;
            int[] lengths = new int[newLength + 1];
            for (int oldIndex = oldEnd - 1; oldIndex >= oldStart; oldIndex--) {
                int diagonal = 0;
                for (int offset = newLength - 1; offset >= 0; offset--) {
                    int nextRow = lengths[offset];
                    if (oldLines[oldIndex].equals(newLines[newStart + offset])) {
                        lengths[offset] = diagonal + 1;
                    } else {
                        lengths[offset] = Math.max(lengths[offset], lengths[offset + 1]);
                    }
                    diagonal = nextRow;
                }
            }
            return lengths;
        }

        private static String[] lines(String content) {
            if (content.isEmpty()) return new String[0];
            String[] raw = content.split("\\R", -1);
            int length = content.endsWith("\n") || content.endsWith("\r") ? raw.length - 1 : raw.length;
            return Arrays.copyOf(raw, length);
        }

        private static boolean hasLinesWithoutFinalNewline(String content, String[] lines) {
            return lines.length > 0 && !content.endsWith("\n") && !content.endsWith("\r");
        }

        private static void appendLine(StringBuilder out, char prefix, String line, boolean missingFinalNewline) {
            out.append(prefix).append(line).append('\n');
            if (missingFinalNewline) out.append("\\ No newline at end of file\n");
        }
    }
}

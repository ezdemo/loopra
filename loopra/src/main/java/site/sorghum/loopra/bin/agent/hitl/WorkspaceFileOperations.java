package site.sorghum.loopra.bin.agent.hitl;

import site.sorghum.loopra.bin.agent.model.ToolCallEntry;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Set;

/** 普通文件写入的授权范围，以会话实际执行目录为准。 */
public final class WorkspaceFileOperations {
    private WorkspaceFileOperations() { }

    public static boolean isFileWrite(ToolCallEntry call) {
        return Set.of("write", "edit").contains(call.name());
    }

    public static boolean isWorkspaceWrite(ToolCallEntry call, Path workspace) {
        if (!isFileWrite(call)) return false;
        Object target = ToolCallEntry.parseArguments(call.arguments()).get("file_path");
        return target instanceof String path && isWithin(workspace, workspace, path);
    }

    public static boolean isWithin(Path workspace, Path directory, String target) {
        if (workspace == null || directory == null || target == null || target.isBlank()
                || target.startsWith("@") || target.startsWith("~")) return false;
        try {
            Path root = realPath(workspace.toAbsolutePath());
            Path path = Path.of(target);
            Path absolute = path.isAbsolute() ? path : directory.resolve(path);
            return realPath(absolute.toAbsolutePath()).startsWith(root);
        } catch (IOException | RuntimeException exception) {
            return false;
        }
    }

    /** 新文件用最近的现存父目录解析真实位置，同样识别父目录中的符号链接。 */
    private static Path realPath(Path path) throws IOException {
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return path.toRealPath();
        Path parent = path.getParent();
        if (parent == null) throw new IOException("No existing ancestor");
        return realPath(parent).resolve(path.getFileName()).normalize();
    }
}

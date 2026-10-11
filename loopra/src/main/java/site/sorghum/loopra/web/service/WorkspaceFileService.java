package site.sorghum.loopra.web.service;

import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.WorkspaceFileEntryDTO;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Stream;

/**
 * 项目文件浏览服务。仅暴露项目内的单层目录项，供前端按需展开。
 */
@Component
public class WorkspaceFileService {

    private static final int MAX_ENTRIES = 200;
    private static final int MAX_SEARCH_RESULTS = 100;
    private static final int MAX_SEARCH_DEPTH = 16;
    private static final Set<String> SEARCH_IGNORED_DIRECTORIES = Set.of(
            ".git", "node_modules", "target", "dist", "build", ".idea");

    @Inject
    private AgentService agentService;

    public List<WorkspaceFileEntryDTO> list(String workspaceHash, String relativePath) {
        Path workspace = resolveWorkspace(workspaceHash);
        Path directory = resolveDirectory(workspace, relativePath);

        try (Stream<Path> entries = Files.list(directory)) {
            return entries
                    .filter(this::isVisible)
                    .sorted(Comparator
                            .comparing((Path path) -> !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
                            .thenComparing(path -> path.getFileName().toString().toLowerCase(Locale.ROOT)))
                    .limit(MAX_ENTRIES)
                    .map(path -> new WorkspaceFileEntryDTO(
                            path.getFileName().toString(),
                            workspace.relativize(path).toString().replace('\\', '/'),
                            Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)))
                    .toList();
        } catch (IOException e) {
            throw new ServiceException("无法读取目录: " + e.getMessage());
        }
    }

    public List<WorkspaceFileEntryDTO> search(String workspaceHash, String query) {
        Path workspace = resolveWorkspace(workspaceHash);
        String keyword = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        List<WorkspaceFileEntryDTO> results = new ArrayList<>();

        try {
            Files.walkFileTree(workspace, Set.of(), MAX_SEARCH_DEPTH, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) {
                    if (!directory.equals(workspace)
                            && SEARCH_IGNORED_DIRECTORIES.contains(directory.getFileName().toString())) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                    if (results.size() >= MAX_SEARCH_RESULTS) return FileVisitResult.TERMINATE;
                    if (!attributes.isRegularFile() || !matchesSearch(workspace, file, keyword)) {
                        return FileVisitResult.CONTINUE;
                    }
                    results.add(new WorkspaceFileEntryDTO(
                            file.getFileName().toString(),
                            workspace.relativize(file).toString().replace('\\', '/'),
                            false));
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException exception) {
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            throw new ServiceException("无法搜索文件: " + e.getMessage());
        }

        results.sort(Comparator
                .comparing((WorkspaceFileEntryDTO entry) -> !entry.name().toLowerCase(Locale.ROOT).startsWith(keyword))
                .thenComparing(entry -> entry.path().toLowerCase(Locale.ROOT)));
        return results;
    }

    /**
     * 删除项目内的文件或目录（递归）。禁止删除项目根目录；symlink 目标必须仍位于项目内。
     */
    public void delete(String workspaceHash, String relativePath) {
        Path workspace = resolveWorkspace(workspaceHash);
        Path target = resolveTarget(workspace, relativePath);
        if (target.equals(workspace)) {
            throw new ServiceException("不能删除项目根目录");
        }
        if (Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            try (Stream<Path> paths = Files.walk(target)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException ignored) {
                        // 单个文件删除失败不阻断其余文件
                    }
                });
            } catch (IOException e) {
                throw new ServiceException("删除目录失败: " + e.getMessage());
            }
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                throw new ServiceException("删除目录失败: 部分文件未能删除");
            }
        } else {
            try {
                Files.deleteIfExists(target);
            } catch (IOException e) {
                throw new ServiceException("删除文件失败: " + e.getMessage());
            }
        }
    }

    private Path resolveTarget(Path workspace, String relativePath) {
        String value = relativePath == null ? "" : relativePath.trim();
        if (value.isEmpty()) {
            throw new ServiceException("无效的文件路径");
        }
        Path requested = workspace.resolve(value).normalize();
        if (!requested.startsWith(workspace)) {
            throw new ServiceException("无效的文件路径");
        }
        try {
            Path target = requested.toRealPath();
            if (!target.startsWith(workspace)) {
                throw new ServiceException("无效的文件路径");
            }
            return target;
        } catch (IOException e) {
            throw new ServiceException("文件或目录不存在或不可访问");
        }
    }

    private Path resolveWorkspace(String workspaceHash) {
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        try {
            Path workspace = Path.of(workspacePath).toRealPath();
            if (!Files.isDirectory(workspace)) {
                throw new ServiceException("项目不是目录");
            }
            return workspace;
        } catch (IOException e) {
            throw new ServiceException("项目不可访问");
        }
    }

    private Path resolveDirectory(Path workspace, String relativePath) {
        String value = relativePath == null ? "" : relativePath.trim();
        Path requested = value.isEmpty() ? workspace : workspace.resolve(value).normalize();
        if (!requested.startsWith(workspace)) {
            throw new ServiceException("无效的文件路径");
        }
        try {
            Path directory = requested.toRealPath();
            if (!directory.startsWith(workspace) || !Files.isDirectory(directory)) {
                throw new ServiceException("无效的文件路径");
            }
            return directory;
        } catch (IOException e) {
            throw new ServiceException("目录不存在或不可访问");
        }
    }

    private boolean isVisible(Path path) {
        try {
            Path realPath = path.toRealPath();
            return realPath.startsWith(path.getParent().toRealPath())
                    && Files.isReadable(path);
        } catch (IOException e) {
            return false;
        }
    }

    private boolean matchesSearch(Path workspace, Path file, String keyword) {
        try {
            Path realFile = file.toRealPath();
            if (!realFile.startsWith(workspace) || !Files.isReadable(realFile)) return false;
            String relativePath = workspace.relativize(file).toString().replace('\\', '/').toLowerCase(Locale.ROOT);
            return keyword.isEmpty() || relativePath.contains(keyword);
        } catch (IOException e) {
            return false;
        }
    }
}

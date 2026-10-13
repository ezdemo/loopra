package site.sorghum.loopra.bin.project;

import lombok.Getter;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.checklist.ChecklistStore;
import site.sorghum.loopra.bin.checklist.JsonChecklistStore;
import site.sorghum.loopra.bin.goal.GoalStore;
import site.sorghum.loopra.bin.goal.JsonlGoalStore;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 用户可见项目根列表的项目注册表。
 * <p>
 * 历史存储布局：
 * ~/.loopra/workspace/{hash}/
 * ├── workspace.json    （项目元数据）
 * └── sessions/         (会话目录)
 * ├── session1.jsonl
 * └── session2.jsonl
 * </p>
 * <p>
 * hash 是工作目录完整路径的 MD5 哈希值（前12位）。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class ProjectRegistry {

    private static final Path WORKSPACES_DIR = Paths.get(
            System.getProperty("user.home"), ".loopra", "workspace");


    private static final Map<String, ProjectRegistry> PROJECT_REGISTRIES = new ConcurrentHashMap<>();

    /**
     * 当前项目路径。
     */
    @Getter
    private String currentProjectPath;


    public ProjectRegistry() {
        try {
            Files.createDirectories(WORKSPACES_DIR);
        } catch (IOException e) {
            log.error("[project] 创建项目目录失败: {}", e.getMessage());
        }
    }

    /**
     * 计算项目目录的 hash 值（MD5 前12位）
     */
    public static String computeProjectHash(String projectPath) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(projectPath.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) {
                sb.append(String.format("%02x", digest[i]));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            // Fallback: 使用简单的 hash
            return String.format("%012x", projectPath.hashCode() & 0xFFFFFFFFFFL);
        }
    }

    /**
     * 获取项目数据目录路径
     */
    public Path getProjectDir(String projectPath) {
        String hash = computeProjectHash(projectPath);
        return WORKSPACES_DIR.resolve(hash);
    }

    /**
     * 获取项目配置文件路径
     */
    public Path getProjectConfigPath(String projectPath) {
        return getProjectDir(projectPath).resolve("workspace.json");
    }

    /**
     * 获取项目会话目录路径
     */
    public Path getSessionsDir(String projectPath) {
        return getProjectDir(projectPath).resolve("sessions");
    }

    /**
     * 获取项目的目标存储。
     *
     * @throws IllegalStateException 如果项目未初始化
     */
    public GoalStore getGoalStore() {
        if (currentProjectPath == null) {
            throw new IllegalStateException("项目未初始化，请先初始化项目");
        }
        Path projectDir = getProjectDir(currentProjectPath);
        return new JsonlGoalStore(projectDir);
    }

    /**
     * 获取项目的清单存储（Checklist 线性步骤模式）。
     *
     * @throws IllegalStateException 如果项目未初始化
     */
    public ChecklistStore getChecklistStore() {
        if (currentProjectPath == null) {
            throw new IllegalStateException("项目未初始化，请先初始化项目");
        }
        Path projectDir = getProjectDir(currentProjectPath);
        return new JsonChecklistStore(projectDir);
    }

    /**
     * 获取或创建项目注册表
     */
    public static ProjectRegistry getOrCreate(String projectPath){
        if (PROJECT_REGISTRIES.containsKey(projectPath)){
            return PROJECT_REGISTRIES.get(projectPath);
        }
        ProjectRegistry manager = new ProjectRegistry();
        manager.initProject(projectPath);
        PROJECT_REGISTRIES.put(projectPath, manager);
        return manager;
    }
    /**
     * 初始化或加载项目
     */
    @SneakyThrows
    public void initProject(String projectPath){
        this.currentProjectPath = projectPath;

        Path projectDir = getProjectDir(projectPath);
        Path sessionsDir = getSessionsDir(projectPath);
        Path configPath = getProjectConfigPath(projectPath);

        // 创建目录结构
        Files.createDirectories(projectDir);
        Files.createDirectories(sessionsDir);

        // 如果配置文件不存在，创建默认配置
        if (!Files.exists(configPath)) {
            createDefaultConfig(projectPath, configPath);
        }
    }

    /**
     * 创建默认的项目配置
     */
    private void createDefaultConfig(String projectPath, Path configPath) throws IOException {
        org.noear.snack4.ONode config = org.noear.snack4.ONode.ofJson("{}");
        config.set("path", projectPath);
        config.set("name", extractProjectName(projectPath));
        config.set("createdAt", System.currentTimeMillis());
        config.set("lastAccessedAt", System.currentTimeMillis());
        Files.writeString(configPath, config.toJson());
    }

    /**
     * 从路径中提取项目名称（最后一级目录名）。
     * 当最后一级是 "." 或 ".." 时，取规范化路径的倒数第二级目录名。
     */
    private String extractProjectName(String projectPath) {
        Path path = Paths.get(projectPath).normalize();
        String fileName = path.getFileName() != null ? path.getFileName().toString() : "";
        // "." 或 ".." 或空（根路径）时，取父目录名
        if (fileName.isEmpty() || ".".equals(fileName) || "..".equals(fileName)) {
            Path parent = path.getParent();
            if (parent != null && parent.getFileName() != null) {
                return parent.getFileName().toString();
            }
            // 仍然为空则回退到绝对路径的末级
            Path abs = path.toAbsolutePath().normalize();
            return abs.getFileName() != null ? abs.getFileName().toString() : projectPath;
        }
        return fileName;
    }

    /**
     * 获取所有已注册的项目
     */
    public List<ProjectInfo> listProjects() throws IOException {
        List<ProjectInfo> projects = new ArrayList<>();
        if (!Files.isDirectory(WORKSPACES_DIR)) return projects;

        try (DirectoryStream<Path> ds = Files.newDirectoryStream(WORKSPACES_DIR)) {
            for (Path dir : ds) {
                if (!Files.isDirectory(dir)) continue;
                Path configPath = dir.resolve("workspace.json");
                if (!Files.exists(configPath)) continue;

                try {
                    String json = Files.readString(configPath);
                    org.noear.snack4.ONode config = org.noear.snack4.ONode.ofJson(json);

                    String path = config.get("path").getString();
                    String name = extractProjectName(path);
                    long createdAt = config.get("createdAt").getLong();
                    long lastAccessedAt = config.get("lastAccessedAt").getLong();

                    // 统计会话数量
                    Path sessionsDir = dir.resolve("sessions");
                    int sessionCount = 0;
                    if (Files.isDirectory(sessionsDir)) {
                        try (DirectoryStream<Path> sessionDs = Files.newDirectoryStream(sessionsDir, "*.jsonl")) {
                            for (Path ignored : sessionDs) {
                                sessionCount++;
                            }
                        }
                    }

                    String hash = dir.getFileName().toString();

                    projects.add(new ProjectInfo(hash, name, path,
                            createdAt, lastAccessedAt, sessionCount));
                } catch (Exception e) {
                    log.error("[project] 读取项目配置失败: {} - {}", dir, e.getMessage());
                }
            }
        }

        // 按创建时间排序（固定顺序，不随切换跳动）
        projects.sort(Comparator.comparingLong(a -> a.createdAt));
        return projects;
    }

    /**
     * 切换到指定项目
     */
    public void switchProject(String projectPath) throws IOException {
        String hash = computeProjectHash(projectPath);
        Path projectDir = WORKSPACES_DIR.resolve(hash);
        Path configPath = projectDir.resolve("workspace.json");

        if (!Files.exists(configPath)) {
            // 项目不存在，自动创建
            initProject(projectPath);
        }

        this.currentProjectPath = projectPath;

        // 更新最后访问时间
        updateLastAccessed(projectPath);

    }

    /**
     * 更新项目最后访问时间
     */
    public void updateLastAccessed(String projectPath) throws IOException {
        Path configPath = getProjectConfigPath(projectPath);
        if (!Files.exists(configPath)) return;

        String json = Files.readString(configPath);
        org.noear.snack4.ONode config = org.noear.snack4.ONode.ofJson(json);
        config.set("lastAccessedAt", System.currentTimeMillis());
        Files.writeString(configPath, config.toJson());
    }

    /**
     * 删除项目
     */
    public boolean deleteProject(String hash) throws IOException {
        Path projectDir = WORKSPACES_DIR.resolve(hash);
        if (!Files.exists(projectDir)) return false;

        // 1. 从 PROJECT_REGISTRIES 静态缓存中移除
        Path configPath = projectDir.resolve("workspace.json");
        if (Files.exists(configPath)) {
            try {
                String json = Files.readString(configPath);
                org.noear.snack4.ONode config = org.noear.snack4.ONode.ofJson(json);
                String path = config.get("path").getString();
                if (path != null && PROJECT_REGISTRIES.remove(path) != null) {
                    log.info("[workspace] 已从缓存中移除: {}", path);
                }
            } catch (Exception e) {
                log.error("[workspace] 清理缓存失败: {}", e.getMessage());
            }
        }

        // 2. 递归删除目录
        deleteDirectory(projectDir);
        return true;
    }

    /**
     * 递归删除目录
     */
    private void deleteDirectory(Path dir) throws IOException {
        if (Files.isDirectory(dir)) {
            try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
                for (Path entry : ds) {
                    deleteDirectory(entry);
                }
            }
        }
        Files.delete(dir);
    }

    public String getCurrentProjectHash() {
        return computeProjectHash(currentProjectPath);
    }

    /**
     * 项目信息
     */
    public record ProjectInfo(String hash, String name, String path, long createdAt, long lastAccessedAt,
                              int sessionCount) {
    }
}

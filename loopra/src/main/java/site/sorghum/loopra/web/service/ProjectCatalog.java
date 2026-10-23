package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ProjectInfoDTO;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/** 项目目录查询、路径解析和关联上下文；不创建 Agent，也不变更项目运行时。 */
@Slf4j
final class ProjectCatalog {
    private final Supplier<Set<String>> sessionKeys;

    ProjectCatalog(Supplier<Set<String>> sessionKeys) {
        this.sessionKeys = sessionKeys;
    }

    String resolveProjectPath(String hash) {
        if (hash == null || hash.isEmpty()) {
            return null;
        }
        // 纯聊天使用内部目录承载会话元数据，但它不是用户项目。
        if (ChatMode.isChatHash(hash)) {
            return ChatMode.root().toString();
        }
        // 1. 优先使用 ProjectRegistry 的磁盘索引（可靠，不依赖 sessionCache）
        try {
            ProjectRegistry projects = new ProjectRegistry();
            List<ProjectRegistry.ProjectInfo> projectList = projects.listProjects();
            for (ProjectRegistry.ProjectInfo ws : projectList) {
                if (hash.equals(ws.hash())) {
                    return ws.path();
                }
            }
        } catch (Exception e) {
            log.warn("[web] 读取项目列表失败: {}", e.getMessage());
        }

        // 2. 检查默认项目
        String defaultPath = getCurrentProject();
        if (defaultPath != null && hash.equals(ProjectRegistry.computeProjectHash(defaultPath))) {
            return defaultPath;
        }

        // 3. 遍历缓存的 Agent key（兼容旧版）
        for (String projectPath : cachedProjectPaths()) {
            if (hash.equals(ProjectRegistry.computeProjectHash(projectPath))) return projectPath;
        }

        // 4. 兼容：hash 可能就是路径本身（旧前端直接传路径）
        if (hash.contains("/") || hash.contains("\\")) {
            return hash;
        }

        // 5. 无法解析
        return null;
    }


    String buildLinkedProjectContext(List<String> hashes, String primaryHash) {
        if (hashes == null || hashes.isEmpty()) return null;
        LinkedHashSet<String> requested = hashes.stream()
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(hash -> !hash.isEmpty() && !hash.equals(primaryHash))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        if (requested.isEmpty()) return null;
        if (requested.size() > 8) {
            throw new ServiceException("单次最多关联 8 个项目");
        }

        Map<String, ProjectInfoDTO> registered = listProjects().stream()
                .collect(Collectors.toMap(ProjectInfoDTO::hash, project -> project, (left, right) -> left));
        List<ProjectInfoDTO> linked = new ArrayList<>(requested.size());
        for (String hash : requested) {
            ProjectInfoDTO project = registered.get(hash);
            if (project == null) {
                throw new ServiceException("关联项目不存在或未注册: " + hash);
            }
            linked.add(project);
        }
        return formatLinkedProjectContext(linked);
    }

    static String formatLinkedProjectContext(List<ProjectInfoDTO> projects) {
        StringBuilder context = new StringBuilder("[系统注入：本轮关联项目]\n")
                .append("以下项目由用户显式选择用于本轮联动。它们不是当前主项目；读取或修改时必须遵守现有工具权限与审批边界。\n");
        for (ProjectInfoDTO project : projects) {
            String name = project.name() == null || project.name().isBlank() ? project.hash() : project.name();
            context.append("- 名称: ").append(name)
                    .append("\n  hash: ").append(project.hash())
                    .append("\n  根目录: ").append(project.path()).append('\n');
        }
        return context.toString().trim();
    }

    String getCurrentProject() {
        LoopraConfig cfg = ConfigService.getConfig();
        if (cfg != null && cfg.workspaceDir() != null) {
            return cfg.workspaceDir().toAbsolutePath().toString();
        }
        return null;
    }

    List<ProjectInfoDTO> listProjects() {
        List<ProjectInfoDTO> result = new ArrayList<>();

        try {
            ProjectRegistry projectRegistry = new ProjectRegistry();
            // 不要在这里调用 switchProject，否则 list 会产生自动创建副作用。
            List<ProjectRegistry.ProjectInfo> projects = projectRegistry.listProjects();

            for (ProjectRegistry.ProjectInfo info : projects) {
                if (ChatMode.isChatRoot(info.path())) continue;
                result.add(new ProjectInfoDTO(
                        info.hash(), info.name(), info.path(),
                        info.createdAt(), info.lastAccessedAt(),
                        info.sessionCount(), info.displayName()
                ));
            }
        } catch (IOException e) {
            log.warn("[web] 获取项目列表失败: {}", e.getMessage());
            // 回退到旧逻辑：从缓存中收集
            Set<String> projectPaths = cachedProjectPaths();

            LoopraConfig cfg = ConfigService.getConfig();
            if (cfg != null && cfg.workspaceDir() != null) {
                projectPaths.add(cfg.workspaceDir().toAbsolutePath().toString());
            }

            for (String path : projectPaths) {
                if (ChatMode.isChatRoot(path)) continue;
                result.add(new ProjectInfoDTO(
                        ProjectRegistry.computeProjectHash(path), null, path,
                        0, 0, 0
                ));
            }
        }

        return applyProjectOrder(result, ConfigService.getWorkspaceOrder());
    }

    ProjectInfoDTO renameProject(String hash, String displayName) {
        try {
            new ProjectRegistry().renameProject(hash, displayName);
            return listProjects().stream().filter(project -> project.hash().equals(hash)).findFirst()
                    .orElseThrow(() -> new ServiceException("项目不存在"));
        } catch (IllegalArgumentException | IOException error) {
            throw new ServiceException("保存项目展示名称失败：" + error.getMessage());
        }
    }

    private Set<String> cachedProjectPaths() {
        Set<String> paths = new HashSet<>();
        for (String key : sessionKeys.get()) {
            paths.add(key.split("::", 2)[0]);
        }
        return paths;
    }

    static List<ProjectInfoDTO> applyProjectOrder(List<ProjectInfoDTO> projects, List<String> order) {
        if (projects == null || projects.isEmpty() || order == null || order.isEmpty()) {
            return projects;
        }
        Map<String, ProjectInfoDTO> byHash = new LinkedHashMap<>();
        for (ProjectInfoDTO project : projects) {
            byHash.put(project.hash(), project);
        }
        List<ProjectInfoDTO> result = new ArrayList<>(projects.size());
        Set<String> placed = new HashSet<>();
        for (String hash : order) {
            ProjectInfoDTO project = byHash.get(hash);
            if (project != null && placed.add(hash)) {
                result.add(project);
            }
        }
        for (ProjectInfoDTO project : projects) {
            if (placed.add(project.hash())) {
                result.add(project);
            }
        }
        return result;
    }

}

package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.talents.mount.catalog.SkillDescriptor;
import site.sorghum.loopra.bin.mcp.McpProjectConfig;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;
import site.sorghum.loopra.tool.solon.mcp.ProjectMcpSkill;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ProjectCapabilitiesDTO;
import site.sorghum.loopra.web.model.ProjectMcpServerDTO;
import site.sorghum.loopra.web.model.ProjectSkillMetaDTO;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Function;

/** 项目 Skill/MCP 摘要及刷新；延迟请求只在整个项目空闲时执行。 */
@Slf4j
final class ProjectCapabilitiesService {

    private final Object runtimeMonitor;
    private final SessionAgentRegistry sessions;
    private final Function<Path, Set<Path>> invalidateTools;
    private final Function<Path, ProjectCapabilitiesDTO> readCapabilities;
    private final Consumer<String> removeProvider;
    private final ConcurrentHashMap<Path, Object> pending = new ConcurrentHashMap<>();

    ProjectCapabilitiesService(Object runtimeMonitor, SessionAgentRegistry sessions, Function<Path, Set<Path>> invalidateTools) {
        this(runtimeMonitor, sessions, invalidateTools,
                ProjectCapabilitiesService::readProjectCapabilities, LoopraSkillProvider::removeFor);
    }

    ProjectCapabilitiesService(Object runtimeMonitor, SessionAgentRegistry sessions, Function<Path, Set<Path>> invalidateTools,
                               Function<Path, ProjectCapabilitiesDTO> readCapabilities, Consumer<String> removeProvider) {
        this.runtimeMonitor = Objects.requireNonNull(runtimeMonitor, "runtimeMonitor");
        this.sessions = Objects.requireNonNull(sessions, "sessions");
        this.invalidateTools = Objects.requireNonNull(invalidateTools, "invalidateTools");
        this.readCapabilities = Objects.requireNonNull(readCapabilities, "readCapabilities");
        this.removeProvider = Objects.requireNonNull(removeProvider, "removeProvider");
    }

    ProjectCapabilitiesDTO get(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) {
            return new ProjectCapabilitiesDTO(null, null, false, null, false, List.of(), List.of());
        }
        Path root = normalize(workspacePath);
        if (root == null) throw new ServiceException("项目路径无效");
        synchronized (runtimeMonitor) {
            return readCapabilities.apply(root);
        }
    }

    String requestRefresh(String workspacePath) {
        Path root = normalize(workspacePath);
        if (root == null) return "WORKSPACE_MISSING: 无法确定当前项目，不能刷新 MCP";
        pending.put(root, new Object());
        return "项目 MCP 刷新已登记。本轮对话完成后会重新读取 .loopra/mcp-servers.json 并重建连接；下一条消息即可使用最新 MCP。";
    }

    ProjectCapabilitiesDTO refresh(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) throw new ServiceException("项目路径不能为空");
        Path root = normalize(workspacePath);
        if (root == null) throw new ServiceException("项目路径无效");
        // 与 Agent 创建、配置重建、后台任务登记共享协调锁，避免检查空闲后再插入新任务。
        synchronized (runtimeMonitor) {
            Object request = pending.get(root);
            return sessions.withIdleProject(root, () -> {
                Set<Path> providerRoots = sessions.disposeProject(root);
                providerRoots.addAll(invalidateTools.apply(root));
                providerRoots.forEach(path -> removeProvider.accept(path.toString()));
                ProjectCapabilitiesDTO result = readCapabilities.apply(root);
                if (request != null) pending.remove(root, request);
                log.info("[mcp-project] 已刷新项目能力: {}，下次聊天将使用最新配置", root);
                return result;
            });
        }
    }

    void applyPending(String workspacePath) {
        Path root = normalize(workspacePath);
        if (root == null) return;
        synchronized (runtimeMonitor) {
            Object request = pending.get(root);
            if (request == null) return;
            try {
                refresh(root.toString());
            } catch (Exception exception) {
                if (sessions.hasBusyProject(root)) {
                    log.debug("[mcp-project] 等待项目会话结束后刷新 MCP: {}", root);
                    return;
                }
                pending.remove(root, request);
                log.warn("[mcp-project] 自动刷新项目 MCP 失败: {}", root, exception);
            }
        }
    }

    private static Path normalize(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) return null;
        try {
            return Path.of(workspacePath).toAbsolutePath().normalize();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static ProjectCapabilitiesDTO readProjectCapabilities(Path projectRoot) {
        LoopraSkillProvider provider = LoopraSkillProvider.getOrCreate(projectRoot.toString());
        provider.getPoolManager().getSkillCatalog().refresh();
        Path skillsPath = projectRoot.resolve(".loopra/skills");
        List<ProjectSkillMetaDTO> skills = provider.getPoolManager().getSkillCatalog().getDescriptors().stream()
                .filter(Objects::nonNull)
                .filter(skill -> "@project-skills".equals(
                        provider.getPoolManager().resolveResource(skill.getId()).getMountAlias()))
                .sorted(Comparator.comparing(SkillDescriptor::getName, Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))
                .map(skill -> {
                    var resource = provider.getPoolManager().resolveResource(skill.getId());
                    return new ProjectSkillMetaDTO(skill.getName(), skill.getDescription(), "project",
                            resource.getMountAlias(), resource.getLocalPath().map(Path::toString).orElse(null));
                })
                .toList();
        ProjectMcpSkill mcp = provider.getProjectMcpSkill();
        List<ProjectMcpServerDTO> servers = mcp == null ? List.of() : mcp.serverInfos().stream()
                .map(server -> new ProjectMcpServerDTO(server.name(), server.type(), server.enabled(), server.loaded(),
                        server.toolCount(), server.toolNames(), server.error() == null ? null : "加载失败"))
                .toList();
        Path configPath = McpProjectConfig.path(projectRoot);
        return new ProjectCapabilitiesDTO(projectRoot.toString(), configPath == null ? null : configPath.toString(),
                configPath != null && Files.isRegularFile(configPath), skillsPath.toString(),
                Files.isDirectory(skillsPath), skills, servers);
    }
}

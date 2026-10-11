package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.entity.ProcessResult;
import site.sorghum.loopra.web.model.EnvironmentStatusDTO;
import site.sorghum.loopra.web.model.WorktreeMergeResultDTO;
import site.sorghum.loopra.web.model.WorktreeStatusDTO;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

/**
 * 会话级隔离分支服务 —— 为开启"隔离分支模式"的会话创建独立 git worktree。
 * <p>
 * 设计要点：
 * <ul>
 *   <li>隔离分支位于 {@code <worktreeBaseDir>/<workspaceHash>-<sessionName>}（默认 ~/.loopra/worktree/），
 *       检出独立分支 {@code loopra/sandbox-<wsHash8>-<sessionName>}（git 禁止两个 worktree 同分支）。</li>
 *   <li>会话身份（JSONL 历史/Goal/Checklist）仍绑定主项目，仅 AI 的文件操作落在隔离分支。</li>
 *   <li>合并回主项目采用<b>隔离分支内反向合并</b>：先在 worktree 中 {@code git merge <主分支>}，
 *       冲突留在隔离分支内由 AI/用户解决（不突破工具路径边界）；干净后在主项目
 *       {@code git merge --ff-only <隔离分支分支>} 快进，随后清理隔离分支与分支。</li>
 * </ul>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class WorktreeService {

    /** worktree add / merge 等耗时操作的超时秒数。 */
    static final long WORKTREE_TIMEOUT_SEC = 180;

    /** 会话隔离分支分支前缀。 */
    static final String BRANCH_PREFIX = "loopra/sandbox-";

    /** 自动提交作者（隔离分支内临时提交，合并回后被快进吸收）。 */
    private static final String AUTO_COMMIT_AUTHOR = "Loopra";
    private static final String AUTO_COMMIT_EMAIL = "loopra@sorghum.site";
    static final String AUTO_COMMIT_MESSAGE = "Apply Loopra changes";

    @Inject
    private GitService gitService;

    @Inject
    private ConfigService configService;

    @Inject
    private AgentService agentService;

    /**
     * 启动时清理孤儿隔离分支：baseDir 下未被任何已注册项目引用（git worktree 列表）
     * 的目录视为上次进程退出残留，直接删除（未合并改动丢失——孤儿意味着主仓库已不认它）。
     */
    @Init
    public void cleanupOrphanWorktrees() {
        try {
            Path base = baseDir();
            if (!Files.isDirectory(base)) return;
            Set<Path> registered = new HashSet<>();
            for (ProjectRegistry.ProjectInfo ws : new ProjectRegistry().listProjects()) {
                File main = new File(ws.path());
                if (!main.isDirectory() || !isGitRepo(main)) continue;
                registered.addAll(registeredWorktrees(main));
            }
            try (Stream<Path> children = Files.list(base)) {
                for (Path child : children.filter(Files::isDirectory).toList()) {
                    Path normalized = child.toAbsolutePath().normalize();
                    if (!registered.contains(normalized)) {
                        deleteRecursively(child);
                        log.info("[worktree] 已清理孤儿隔离分支目录: {}", child);
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[worktree] 孤儿隔离分支清理失败（不影响启动）: {}", e.getMessage());
        }
    }

    /** 递归删除目录（限制在 baseDir 内的目录使用）。 */
    private static void deleteRecursively(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                    // 单文件删除失败不阻塞整体清理
                }
            }
        } catch (Exception ignored) {
        }
    }

    // ==================== 路径/分支命名 ====================

    /** 隔离分支根目录（全局配置 worktreeBaseDir，默认 ~/.loopra/worktree；可用系统属性 loopra.worktree.baseDir 覆盖，供测试/嵌入方使用）。 */
    public Path baseDir() {
        String sysProp = System.getProperty("loopra.worktree.baseDir");
        if (sysProp != null && !sysProp.isBlank()) {
            return Paths.get(sysProp).toAbsolutePath().normalize();
        }
        LoopraConfig cfg = ConfigService.getConfig();
        String dir = cfg != null ? cfg.worktreeBaseDir() : null;
        Path base = dir != null && !dir.isBlank()
                ? Paths.get(dir) : Paths.get(System.getProperty("user.home"), ".loopra", "worktree");
        return base.toAbsolutePath().normalize();
    }

    /** 会话隔离分支磁盘路径：&lt;base&gt;/&lt;workspaceHash&gt;-&lt;sessionName&gt;。 */
    public Path pathFor(String workspaceHash, String sessionName) {
        return baseDir().resolve(sanitize(workspaceHash) + "-" + sanitize(sessionName));
    }

    /** 会话隔离分支分支名。 */
    public String branchFor(String workspaceHash, String sessionName) {
        String wsHash = workspaceHash == null ? "" : workspaceHash;
        String shortHash = wsHash.length() <= 8 ? wsHash : wsHash.substring(0, 8);
        return BRANCH_PREFIX + sanitize(shortHash) + "-" + sanitize(sessionName);
    }

    /** 分支/目录名安全化：仅保留字母数字、下划线、连字符与点，并限制长度。 */
    static String sanitize(String name) {
        String safe = name == null ? "" : name.replaceAll("[^\\p{L}\\p{N}_\\-.\\[\\]]", "_");
        return safe.length() > 80 ? safe.substring(0, 80) : safe;
    }

    // ==================== 公开操作（按 workspaceHash） ====================

    /**
     * 查询会话隔离分支状态。主项目非 Git 仓库时返回 exists=false 及说明，不抛异常。
     */
    public WorktreeStatusDTO status(String workspaceHash, String sessionName) {
        File main = mainWorkspace(workspaceHash);
        if (main == null) {
            return new WorktreeStatusDTO(workspaceHash, sessionName, false, null, null, false, null, "未设置项目");
        }
        return statusAt(main.getPath(), sessionName);
    }

    /**
     * 描述会话当前实际使用的环境。Git 提交、合并和推送由 Desktop 端执行，
     * 后端只提供主项目与 Agent 文件根之间的权威映射。
     */
    public EnvironmentStatusDTO environment(String workspaceHash, String sessionName) {
        File main = mainWorkspace(workspaceHash);
        if (main == null) {
            return new EnvironmentStatusDTO(workspaceHash, sessionName, "unavailable",
                    null, null, false, null, null, false, false, false, "未设置项目");
        }
        String resolvedHash = hashOf(main.getPath());
        String mainBranch = simple(main, "git", "rev-parse", "--abbrev-ref", "HEAD");
        boolean mainDirty = hasChanges(main, main.toPath());
        boolean agentRunning = agentService != null
                && agentService.getSessionStatus(main.getPath(), sessionName).running();
        boolean worktreeMode = agentService != null
                && agentService.isSessionWorktreeMode(main.getPath(), sessionName);
        if (!worktreeMode) {
            return new EnvironmentStatusDTO(resolvedHash, sessionName, "local",
                    main.getPath(), mainBranch, mainDirty,
                    main.getPath(), mainBranch, mainDirty, false, agentRunning, "当前 Agent 使用本地项目");
        }

        Path wt = pathFor(resolvedHash, sessionName);
        boolean exists = Files.exists(wt) && isRegisteredWorktree(main, wt);
        if (!exists) {
            return new EnvironmentStatusDTO(resolvedHash, sessionName, "worktree",
                    main.getPath(), mainBranch, mainDirty,
                    null, null, false, false, agentRunning, "隔离分支将在会话首次运行时创建");
        }
        String currentBranch = simple(main, "git", "-C", wt.toString(), "branch", "--show-current");
        boolean currentDirty = hasChanges(main, wt);
        return new EnvironmentStatusDTO(resolvedHash, sessionName, "worktree",
                main.getPath(), mainBranch, mainDirty,
                wt.toString(), currentBranch, currentDirty, true, agentRunning,
                currentDirty ? "Agent 正在使用隔离分支" : "隔离分支干净");
    }

    /** 按项目路径查询状态（供测试与内部复用）。 */
    WorktreeStatusDTO statusAt(String workspacePath, String sessionName) {
        String wsHash = hashOf(workspacePath);
        File main = new File(workspacePath);
        if (!isGitRepo(main)) {
            return new WorktreeStatusDTO(wsHash, sessionName, false,
                    pathFor(wsHash, sessionName).toString(), null, false, null,
                    "项目不是 Git 仓库，无法使用隔离分支模式");
        }
        String mainBranch = simple(main, "git", "rev-parse", "--abbrev-ref", "HEAD");
        Path wt = pathFor(wsHash, sessionName);
        boolean exists = Files.exists(wt) && isRegisteredWorktree(main, wt);
        String branch = exists ? simple(main, "git", "-C", wt.toString(), "branch", "--show-current") : null;
        boolean dirty = exists && hasChanges(main, wt);
        return new WorktreeStatusDTO(wsHash, sessionName, exists,
                wt.toString(), branch, dirty, mainBranch,
                exists ? (dirty ? "隔离分支有未提交改动" : "隔离分支干净") : "隔离分支未创建");
    }

    /**
     * 创建会话隔离分支（幂等：已存在时直接返回状态）。
     * 基于主项目当前 HEAD 创建独立分支并检出。
     */
    public WorktreeStatusDTO create(String workspaceHash, String sessionName) {
        if (sessionName == null || sessionName.isBlank()) throw new ServiceException("会话名称不能为空");
        return createAt(requireMainWorkspace(workspaceHash).getPath(), sessionName);
    }

    /** 按项目路径创建隔离分支（供测试与内部复用）。 */
    WorktreeStatusDTO createAt(String workspacePath, String sessionName) {
        if (sessionName == null || sessionName.isBlank()) throw new ServiceException("会话名称不能为空");
        File main = requireMainWorkspacePath(workspacePath);
        String wsHash = hashOf(workspacePath);
        Path wt = pathFor(wsHash, sessionName);
        String branch = branchFor(wsHash, sessionName);

        if (Files.exists(wt) && isRegisteredWorktree(main, wt)) {
            return statusAt(workspacePath, sessionName);
        }
        if (Files.exists(wt)) {
            throw new ServiceException("目标目录已存在但不是已注册的 worktree，请手动处理: " + wt);
        }

        try {
            Files.createDirectories(baseDir());
            boolean branchExists = simple(main, "git", "branch", "--list", branch) != null;
            ProcessResult result = branchExists
                    ? gitService.runGit(main, WORKTREE_TIMEOUT_SEC, "git", "worktree", "add", wt.toString(), branch)
                    : gitService.runGit(main, WORKTREE_TIMEOUT_SEC, "git", "worktree", "add", wt.toString(), "-b", branch, "HEAD");
            if (result.exitCode != 0) {
                throw new ServiceException("创建隔离分支失败: " + result.stderr);
            }
            // 软链主项目的 .codegraph 索引（Junction/符号链接），让 codegraph_explore 等
            // 依赖索引的技能在隔离分支内可用；失败时不影响功能（AI 可显式传主项目路径）。
            linkCodegraphIndexes(main, wt);
            log.info("[worktree] 已创建会话隔离分支: {} (分支 {})", wt, branch);
            return statusAt(workspacePath, sessionName);
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("创建隔离分支失败: " + e.getMessage());
        }
    }

    /**
     * 删除会话隔离分支及其分支。
     *
     * @param discardChanges 为 true 时强制删除（丢弃隔离分支内所有未提交/未合并改动）
     */
    public WorktreeStatusDTO remove(String workspaceHash, String sessionName, boolean discardChanges) {
        File main = mainWorkspace(workspaceHash);
        String wsHash = hashOf(main == null ? workspaceHash : main.getPath());
        Path wt = pathFor(wsHash, sessionName);
        if (main == null || !Files.exists(wt)) {
            return new WorktreeStatusDTO(wsHash, sessionName, false, wt.toString(), null, false, null, "隔离分支不存在");
        }
        return removeAt(main.getPath(), sessionName, discardChanges);
    }

    /** 按项目路径删除隔离分支（供测试与内部复用）。 */
    WorktreeStatusDTO removeAt(String workspacePath, String sessionName, boolean discardChanges) {
        File main = new File(workspacePath);
        String wsHash = hashOf(workspacePath);
        Path wt = pathFor(wsHash, sessionName);
        String branch = branchFor(wsHash, sessionName);
        if (!Files.exists(wt)) {
            return new WorktreeStatusDTO(wsHash, sessionName, false, wt.toString(), null, false, null, "隔离分支不存在");
        }
        try {
            List<String> cmd = new ArrayList<>(List.of("git", "worktree", "remove"));
            if (discardChanges) cmd.add("--force");
            cmd.add(wt.toString());
            ProcessResult result = gitService.runGit(main, WORKTREE_TIMEOUT_SEC, cmd.toArray(new String[0]));
            if (result.exitCode != 0) {
                throw new ServiceException("删除隔离分支失败: " + result.stderr);
            }
            // 分支删除失败不阻塞主流程（分支残留可被后续创建复用）
            ProcessResult branchDel = gitService.runGit(main, "git", "branch", "-D", branch);
            if (branchDel.exitCode != 0) {
                log.warn("[worktree] 删除分支 {} 失败: {}", branch, branchDel.stderr.trim());
            }
            // 清理工具系统缓存（MountManager 根指向已删除的隔离分支）
            site.sorghum.loopra.tool.solon.common.LoopraSkillProvider.removeFor(wt.toString());
            log.info("[worktree] 已删除会话隔离分支: {} (分支 {})", wt, branch);
            return new WorktreeStatusDTO(wsHash, sessionName, false, wt.toString(), null, false,
                    simple(main, "git", "rev-parse", "--abbrev-ref", "HEAD"), "已删除");
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("删除隔离分支失败: " + e.getMessage());
        }
    }

    /**
     * 将隔离分支分支合并回主项目。
     * <p>流程：隔离分支内反向合并主分支（冲突留在隔离分支内）→ 干净则主项目 ff-only 快进。
     * 有冲突时保留隔离分支并返回冲突文件列表，供 AI/用户解决后再次调用。</p>
     */
    public WorktreeMergeResultDTO mergeBack(String workspaceHash, String sessionName) {
        return mergeBackAt(requireMainWorkspace(workspaceHash).getPath(), sessionName);
    }

    /** 按项目路径执行合并回主项目（供测试与内部复用）。 */
    WorktreeMergeResultDTO mergeBackAt(String workspacePath, String sessionName) {
        File main = new File(workspacePath);
        String wsHash = hashOf(workspacePath);
        Path wt = pathFor(wsHash, sessionName);
        if (!Files.exists(wt) || !isRegisteredWorktree(main, wt)) {
            return new WorktreeMergeResultDTO(false, false, List.of(), null, false,
                    "会话隔离分支不存在，无需合并");
        }
        String mainBranch = simple(main, "git", "rev-parse", "--abbrev-ref", "HEAD");
        if (mainBranch == null || "HEAD".equals(mainBranch)) {
            throw new ServiceException("主项目处于 detached HEAD 状态，无法合并");
        }
        String worktreeBranch = branchFor(wsHash, sessionName);

        try {
            // 1. 隔离分支有未提交改动时自动提交（保持 AI 无需关心 git 细节）；
            //    元数据目录（.loopra）以主分支版本为准，避免记忆/共享上下文反向覆盖主项目
            if (hasChanges(main, wt)) {
                restoreMetadataFromMain(main, wt, mainBranch);
                ProcessResult add = gitService.runGit(main, WORKTREE_TIMEOUT_SEC,
                        "git", "-C", wt.toString(), "add", "-A");
                if (add.exitCode != 0) {
                    throw new ServiceException("隔离分支暂存失败: " + add.stderr);
                }
                String commitMessage = AUTO_COMMIT_MESSAGE;
                try {
                    commitMessage = gitService.generateCommitMessageAt(wt.toFile(), wsHash);
                } catch (Exception e) {
                    log.warn("[worktree] AI 生成提交标题失败，使用默认标题: {}", e.getMessage());
                }
                ProcessResult commit = gitService.runGit(main, WORKTREE_TIMEOUT_SEC,
                        "git", "-C", wt.toString(), "-c", "user.name=" + AUTO_COMMIT_AUTHOR,
                        "-c", "user.email=" + AUTO_COMMIT_EMAIL,
                        "commit", "-m", commitMessage);
                if (commit.exitCode != 0 && !commit.stderr.contains("nothing to commit")) {
                    throw new ServiceException("隔离分支提交失败: " + commit.stderr);
                }
            }

            // 2. 隔离分支内反向合并主分支（冲突留在隔离分支，不触碰主项目）
            ProcessResult reverse = gitService.runGit(main, WORKTREE_TIMEOUT_SEC,
                    "git", "-C", wt.toString(), "merge", "--no-edit", mainBranch);
            if (reverse.exitCode != 0) {
                List<String> conflicts = conflictFiles(main, wt);
                log.info("[worktree] 反向合并冲突: {} 个文件，等待解决", conflicts.size());
                return new WorktreeMergeResultDTO(false, true, conflicts, null, false,
                        "合并冲突，需在隔离分支内解决后再次合并；冲突文件数: " + conflicts.size());
            }

            // 3. 主项目必须干净才能 ff-only 快进
            if (hasChanges(main, main.toPath())) {
                throw new ServiceException("主项目有未提交改动，请先提交或使用 git stash 暂存后再合并");
            }
            ProcessResult ff = gitService.runGit(main, WORKTREE_TIMEOUT_SEC,
                    "git", "merge", "--ff-only", worktreeBranch);
            if (ff.exitCode != 0) {
                throw new ServiceException("主项目快进合并失败: " + ff.stderr);
            }
            String head = simple(main, "git", "rev-parse", "HEAD");

            // 4. 保留隔离分支与分支，供同一会话继续隔离修改和后续再次合并。
            //    会话删除时由 AgentService 统一清理隔离分支与分支。
            log.info("[worktree] 会话隔离分支已合并回主项目并保留: {}/{} -> {}", wsHash, sessionName, head);
            return new WorktreeMergeResultDTO(true, false, List.of(), head, false,
                    "已合并回主项目，隔离分支继续保留");
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("合并隔离分支失败: " + e.getMessage());
        }
    }

    /**
     * 按会话合并模式执行合并回主项目：
     * <ul>
     *   <li>{@code manual}：有冲突直接返回冲突列表，由用户/AI 手动处理。</li>
     *   <li>{@code ai-auto} / {@code ai-auto-approve}：有冲突时自动触发一次 AI 解决回合
     *       （普通 Loop turn），解决完成后需再次调用本方法完成快进合并。</li>
     * </ul>
     */
    public WorktreeMergeResultDTO mergeBackWithPolicy(String workspaceHash, String sessionName) {
        WorktreeMergeResultDTO result = mergeBack(workspaceHash, sessionName);
        if (!result.conflicted()) {
            return result;
        }
        String workspacePath = gitService.resolveWorkspace(workspaceHash);
        String mergeMode = agentService.getSessionMergeMode(workspacePath, sessionName);
        boolean aiAuto = "ai-auto".equals(mergeMode) || "ai-auto-approve".equals(mergeMode);
        if (aiAuto) {
            boolean started = agentService.triggerWorktreeConflictResolution(
                    workspacePath, sessionName, result.conflictFiles(), "ai-auto-approve".equals(mergeMode));
            return new WorktreeMergeResultDTO(false, true, result.conflictFiles(), null, false,
                    started
                            ? "已触发 AI 自动解决合并冲突（" + mergeMode + "），解决完成后请再次点击合并"
                            : result.message() + "（会话 Agent 未初始化或正在运行，无法自动解决）");
        }
        return result;
    }

    // ==================== 内部工具 ====================

    private File mainWorkspace(String workspaceHash) {
        try {
            String path = gitService.resolveWorkspace(workspaceHash);
            return path == null ? null : new File(path);
        } catch (Exception e) {
            return null;
        }
    }

    private File requireMainWorkspace(String workspaceHash) {
        File main = mainWorkspace(workspaceHash);
        if (main == null) throw new ServiceException("未设置项目");
        if (!isGitRepo(main)) {
            throw new ServiceException("项目不是 Git 仓库，无法使用隔离分支模式");
        }
        return main;
    }

    /** 按路径校验主项目（供测试与路径级内部方法使用）。 */
    private File requireMainWorkspacePath(String workspacePath) {
        File main = new File(workspacePath);
        if (!main.isDirectory()) throw new ServiceException("项目不可访问: " + workspacePath);
        if (!isGitRepo(main)) {
            throw new ServiceException("项目不是 Git 仓库，无法使用隔离分支模式");
        }
        return main;
    }

    /** 项目路径 hash（供路径级方法使用）。 */
    static String hashOf(String workspacePath) {
        return workspacePath == null ? "" : ProjectRegistry.computeProjectHash(workspacePath);
    }

    private boolean isGitRepo(File dir) {
        try {
            ProcessResult result = gitService.runGit(dir, "git", "rev-parse", "--is-inside-work-tree");
            return result.exitCode == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** 是否已注册到主仓库的 worktree 列表。 */
    private boolean isRegisteredWorktree(File main, Path wt) {
        return registeredWorktrees(main).contains(wt.toAbsolutePath().normalize());
    }

    /** 解析 {@code git worktree list --porcelain} 返回已注册 worktree 路径集合。 */
    Set<Path> registeredWorktrees(File main) {
        Set<Path> paths = new HashSet<>();
        try {
            ProcessResult result = gitService.runGit(main, "git", "worktree", "list", "--porcelain");
            if (result.exitCode != 0) return paths;
            for (String line : result.stdout.split("\n")) {
                if (line.startsWith("worktree ")) {
                    paths.add(Paths.get(line.substring("worktree ".length())).toAbsolutePath().normalize());
                }
            }
        } catch (Exception e) {
            log.warn("[worktree] 枚举 worktree 列表失败: {}", e.getMessage());
        }
        return paths;
    }

    /** 目录是否有未提交改动（status --porcelain 非空）。 */
    private boolean hasChanges(File main, Path dir) {
        try {
            ProcessResult result = gitService.runGit(main, "git", "-C", dir.toString(), "status", "--porcelain");
            return result.exitCode == 0 && result.stdout != null && !result.stdout.trim().isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 隔离分支内 .loopra 元数据目录（项目记忆/共享上下文）以主分支版本为准：
     * 合并回主项目时不允许隔离分支内的记忆/协作数据反向覆盖主项目。
     */
    private void restoreMetadataFromMain(File main, Path wt, String mainBranch) {
        try {
            ProcessResult result = gitService.runGit(main, WORKTREE_TIMEOUT_SEC,
                    "git", "-C", wt.toString(), "checkout", mainBranch, "--", ".loopra");
            if (result.exitCode != 0) {
                log.debug("[worktree] 恢复 .loopra 元数据失败（可忽略）: {}", result.stderr.trim());
            }
        } catch (Exception e) {
            log.debug("[worktree] 恢复 .loopra 元数据异常（可忽略）: {}", e.getMessage());
        }
    }

    /**
     * 将主项目的 .codegraph 索引以符号链接/Junction 形式带入隔离分支，
     * 并写入 .git/info/exclude 防止索引目录被 git add -A 误纳入提交。
     * 仅索引目录本体，不复制内容；平台不支持或目标缺失时静默跳过。
     */
    private void linkCodegraphIndexes(File main, Path wt) {
        File mainDir = main;
        File[] indexes = mainDir.listFiles((dir, name) -> name.startsWith(".codegraph"));
        if (indexes == null || indexes.length == 0) return;
        try {
            Path exclude = wt.resolve(".git/info/exclude");
            if (Files.exists(exclude)) {
                Files.writeString(exclude, "\n# loopra worktree indexes\n.codegraph*\n",
                        java.nio.charset.StandardCharsets.UTF_8,
                        java.nio.file.StandardOpenOption.APPEND);
            }
        } catch (Exception ignored) {
        }
        for (File index : indexes) {
            Path link = wt.resolve(index.getName());
            if (Files.exists(link)) continue;
            try {
                if (System.getProperty("os.name").toLowerCase().contains("win")) {
                    // Windows Junction（无需管理员权限）
                    Process p = new ProcessBuilder("cmd", "/c", "mklink", "/J",
                            link.toString(), index.getAbsolutePath()).start();
                    p.waitFor();
                } else {
                    Files.createSymbolicLink(link, index.toPath());
                }
                log.info("[worktree] 已链入索引: {} -> {}", link, index.getName());
            } catch (Exception e) {
                log.debug("[worktree] 链入 .codegraph 索引失败（可忽略）: {}", e.getMessage());
            }
        }
    }

    /** 冲突文件列表（相对仓库根）。 */
    private List<String> conflictFiles(File main, Path wt) {
        try {
            ProcessResult result = gitService.runGit(main, "git", "-C", wt.toString(),
                    "diff", "--name-only", "--diff-filter=U");
            if (result.exitCode != 0 || result.stdout == null) return List.of();
            List<String> files = new ArrayList<>();
            for (String line : result.stdout.split("\n")) {
                if (!line.isBlank()) files.add(line.trim());
            }
            return files;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** 执行简单查询命令，成功返回 stdout 首行，失败返回 null。 */
    private String simple(File workDir, String... args) {
        try {
            ProcessResult result = gitService.runGit(workDir, args);
            return result.exitCode == 0 && result.stdout != null
                    ? result.stdout.trim().isEmpty() ? null : result.stdout.trim()
                    : null;
        } catch (Exception e) {
            return null;
        }
    }
}

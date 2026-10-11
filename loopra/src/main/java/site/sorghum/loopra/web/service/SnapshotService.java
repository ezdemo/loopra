package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 快照检查点服务 —— 基于 Git 底层命令实现项目快照与撤回。
 * <p>
 * 核心流程：
 * <pre>
 * 1. createCheckpoint(): AI 执行修改前，保存当前项目快照
 *    ├── git add -A
 *    ├── git write-tree → tree hash
 *    ├── git commit-tree → commit hash（在 bare repo 中）
 *    ├── git update-ref refs/snapshots/msg/{msgId} → commit hash
 *    └── 返回 commit hash
 *
 * 2. rollbackToSnapshot(): 用户撤回时，从快照恢复项目
 *    ├── git cat-file {commitHash} → tree hash
 *    ├── git read-tree {treeHash}
 *    ├── git checkout-index -a -f（工作目录恢复）
 *    └── 返回恢复结果
 * </pre>
 * <p>
 * 快照存储在项目的 .git/refs/snapshots/ 命名空间下，
 * 每条消息对应一个快照引用，不污染用户的分支和提交历史。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class SnapshotService {

    @Inject
    private AgentService agentService;

    /** Git 命令超时秒数 */
    private static final int GIT_COMMAND_TIMEOUT_SEC = 15;
    /** 单个 Git 输出流在内存中保留的最大字符数 */
    private static final int MAX_GIT_OUTPUT_CHARS = 10 * 1024 * 1024;
    /** 命令结束后等待输出流消费完成的最大秒数 */
    private static final int GIT_OUTPUT_DRAIN_TIMEOUT_SEC = 1;
    /**
     * Git 子进程的标准输出与错误输出必须并发消费，避免管道缓冲区写满造成死锁。
     * <p>此前先读 stdout 再读 stderr：git add -A 在修改文件多时向 stderr 输出大量
     * CRLF 警告，写满管道后进程阻塞、stdout 永不 EOF，读流线程永久卡死。</p>
     */
    private static final ExecutorService SNAPSHOT_IO_EXECUTOR = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "loopra-snapshot-git-io");
        thread.setDaemon(true);
        return thread;
    });
    /** 快照引用前缀 */
    private static final String SNAPSHOT_REF_PREFIX = "refs/snapshots/msg/";
    /** 默认快照提交作者 */
    private static final String SNAPSHOT_AUTHOR_NAME = "Loopra-Snapshot";
    private static final String SNAPSHOT_AUTHOR_EMAIL = "snapshot@loopra.sorghum.site";

    /**
     * 内存缓存：sessionKey → 有序快照列表（按消息顺序）。
     * 结构：每个 sessionKey 对应一个 LinkedHashMap<msgId, SnapshotInfo>，
     * 保证插入顺序，便于按索引撤回。
     */
    private final ConcurrentHashMap<String, LinkedHashMap<String, SnapshotInfo>> snapshotRegistry = new ConcurrentHashMap<>();

    // ==================== 公开方法 ====================

    /**
     * 创建快照检查点 —— 在 AI 执行代码修改前调用。
     * <p>
     * 执行流程：
     * 1. git add -A（将所有变更加入暂存区）
     * 2. git write-tree（从暂存区生成 tree 对象）
     * 3. git commit-tree（用 tree 创建 commit 对象，不更新任何分支）
     * 4. git update-ref（将 commit 存储到 refs/snapshots/msg/{msgId}）
     * </p>
     *
     * @param workspaceHash 项目 hash
     * @param msgId         消息 ID（用于标识快照）
     * @return 快照信息
     */
    public SnapshotInfo createCheckpoint(String workspaceHash, String msgId) {
        String workspacePath = resolveWorkspace(workspaceHash);
        File workspaceDir = new File(workspacePath);

        // 1. 确认是 git 仓库
        ensureGitRepo(workspaceDir);

        try {
            return doCreateCheckpoint(workspaceDir, workspaceHash, msgId);
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("快照失败: " + e.getMessage());
        }
    }

    /**
     * 执行快照创建的核心逻辑。
     */
    private SnapshotInfo doCreateCheckpoint(File workspaceDir, String workspaceHash, String msgId) throws Exception {
        // 2a. 保存用户当前的暂存状态：记录哪些文件已被用户 git add
        String userStagedRaw = runGitSimple(workspaceDir, "diff", "--cached", "--name-only");
        List<String> userStagedFiles = new ArrayList<>();
        if (userStagedRaw != null && !userStagedRaw.trim().isEmpty()) {
            for (String file : userStagedRaw.split("\n")) {
                String trimmed = file.trim();
                if (!trimmed.isEmpty()) {
                    userStagedFiles.add(trimmed);
                }
            }
        }

        // 2b. git add -A：将所有变更加入暂存区（包括用户的修改）
        ProcessResult addResult = runGit(workspaceDir, "git", "add", "-A");
        if (addResult.exitCode != 0) {
            throw new ServiceException("快照失败: git add 失败 - " + addResult.stderr);
        }

        // 3. git write-tree：从暂存区生成 tree 对象，返回 tree hash
        String treeHash = runGitSimple(workspaceDir, "write-tree");
        if (treeHash == null || treeHash.trim().isEmpty()) {
            throw new ServiceException("快照失败: 无法生成 tree 对象");
        }
        treeHash = treeHash.trim();

        // 4. 获取当前 HEAD commit 作为父提交（如果存在的话）
        String parentCommit = runGitSimple(workspaceDir, "rev-parse", "HEAD");
        parentCommit = (parentCommit != null && !parentCommit.trim().isEmpty()) ? parentCommit.trim() : null;

        // 5. git commit-tree：创建一个 dangling commit（不更新任何分支/HEAD）
        List<String> commitTreeCmd = new ArrayList<>();
        commitTreeCmd.add("git");
        commitTreeCmd.add("-c");
        commitTreeCmd.add("user.name=" + SNAPSHOT_AUTHOR_NAME);
        commitTreeCmd.add("-c");
        commitTreeCmd.add("user.email=" + SNAPSHOT_AUTHOR_EMAIL);
        commitTreeCmd.add("commit-tree");
        commitTreeCmd.add(treeHash);
        commitTreeCmd.add("-m");
        commitTreeCmd.add("snapshot: checkpoint before AI modification [" + msgId + "]");
        if (parentCommit != null) {
            commitTreeCmd.add("-p");
            commitTreeCmd.add(parentCommit);
        }
        ProcessResult commitResult = runGit(workspaceDir, commitTreeCmd.toArray(new String[0]));
        if (commitResult.exitCode != 0) {
            throw new ServiceException("快照失败: commit-tree 失败 - " + commitResult.stderr);
        }
        String commitHash = commitResult.stdout.trim();

        if (commitHash == null || commitHash.isEmpty()) {
            throw new ServiceException("快照失败: 无法创建 commit 对象");
        }

        // 6. git update-ref：将 commit hash 存储到 refs/snapshots/msg/{msgId}
        String refName = SNAPSHOT_REF_PREFIX + msgId;
        String updateRefResult = runGitSimple(workspaceDir, "update-ref", refName, commitHash);
        if (updateRefResult == null) {
            // update-ref 在成功时无输出，失败时返回非零退出码
            // 但 runGitSimple 返回 null 表示失败，这里需要验证
            String verifyRef = runGitSimple(workspaceDir, "rev-parse", refName);
            if (verifyRef == null || !verifyRef.trim().equals(commitHash)) {
                log.warn("[snapshot] update-ref 可能失败，尝试验证 ref: 期望={}, 实际={}", commitHash, verifyRef);
                // 不抛异常，快照 commit 对象仍然存在，只是 ref 引用可能未更新
            }
        }

        // 7. 重置暂存区为 HEAD，避免 git add -A 影响用户的 git 状态
        //    使用 --mixed 模式，只清暂存区，不修改工作目录
        runGit(workspaceDir, "git", "reset", "HEAD", "--");

        // 8. 恢复用户原先暂存的文件：将用户之前 git add 的文件重新暂存
        if (!userStagedFiles.isEmpty()) {
            for (String file : userStagedFiles) {
                runGitSimple(workspaceDir, "add", "--", file);
            }
            log.debug("[snapshot] 已恢复 {} 个文件的暂存状态", userStagedFiles.size());
        }

        // 9. 记录快照信息
        SnapshotInfo info = new SnapshotInfo(msgId, commitHash, treeHash, System.currentTimeMillis());
        registerSnapshot(workspaceHash, msgId, info);

        log.info("[snapshot] 快照创建成功: msgId={}, commitHash={}, treeHash={}", msgId, commitHash, treeHash);
        return info;
    }

    /**
     * 撤回到指定快照 —— 恢复项目到快照时的状态。
     * <p>
     * 执行流程：
     * 1. 从 ref 中读取 commit hash
     * 2. git cat-file 读取 commit 获取 tree hash
     * 3. git read-tree 将 tree 读入暂存区
     * 4. git checkout-index -a -f 将暂存区内容检出到工作目录
     * </p>
     *
     * @param workspaceHash 项目 hash
     * @param msgId         要撤回的消息 ID
     * @return 恢复结果
     */
    public SnapshotRollbackResult rollbackToSnapshot(String workspaceHash, String msgId) {
        String workspacePath = resolveWorkspace(workspaceHash);
        File workspaceDir = new File(workspacePath);

        // 1. 确认是 git 仓库
        ensureGitRepo(workspaceDir);

        // 2. 从 ref 获取 commit hash
        String refName = SNAPSHOT_REF_PREFIX + msgId;
        String commitHash = runGitSimple(workspaceDir, "rev-parse", refName);
        if (commitHash == null || commitHash.trim().isEmpty()) {
            throw new ServiceException("撤回失败: 未找到消息 " + msgId + " 的快照");
        }
        commitHash = commitHash.trim();

        // 3. 从 commit 对象获取 tree hash
        String treeHash = runGitSimple(workspaceDir, "rev-parse", commitHash + "^{tree}");
        if (treeHash == null || treeHash.trim().isEmpty()) {
            throw new ServiceException("撤回失败: 无法读取快照的 tree 对象");
        }
        treeHash = treeHash.trim();

        // 4. git read-tree：将 tree 读入 index（暂存区）
        try {
            ProcessResult readTreeResult = runGit(workspaceDir, "git", "read-tree", treeHash);
            if (readTreeResult.exitCode != 0) {
                throw new ServiceException("撤回失败: read-tree 失败 - " + readTreeResult.stderr);
            }
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("撤回失败: " + e.getMessage());
        }

        // 5. git checkout-index -a -f：将暂存区内容强制检出到工作目录
        try {
            ProcessResult checkoutResult = runGit(workspaceDir, "git", "checkout-index", "-a", "-f");
            if (checkoutResult.exitCode != 0) {
                throw new ServiceException("撤回失败: checkout-index 失败 - " + checkoutResult.stderr);
            }
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("撤回失败: " + e.getMessage());
        }

        // 6. 清理：重置 index 为 HEAD，使 git status 恢复正常
        try {
            runGit(workspaceDir, "git", "reset", "HEAD", "--");
        } catch (Exception e) {
            log.debug("[snapshot] 重置暂存区失败（可忽略）: {}", e.getMessage());
        }

        // 7. 移除该消息之后的所有快照（撤回后，后续快照失效）
        discardSnapshotsAfter(workspaceHash, msgId);

        log.info("[snapshot] 撤回成功: msgId={}, 恢复到 treeHash={}", msgId, treeHash);
        return new SnapshotRollbackResult(msgId, commitHash, treeHash, true, "项目已恢复到消息 " + msgId + " 之前的状态");
    }

    /**
     * 列出当前会话的所有快照。
     *
     * @param workspaceHash 项目 hash
     * @param sessionName   会话名称（可选，不传则列出所有）
     * @return 快照列表
     */
    public List<SnapshotInfo> listSnapshots(String workspaceHash, String sessionName) {
        String registryKey = buildRegistryKey(workspaceHash, sessionName);
        LinkedHashMap<String, SnapshotInfo> snapshots = snapshotRegistry.get(registryKey);
        if (snapshots == null || snapshots.isEmpty()) {
            return Collections.emptyList();
        }
        return new ArrayList<>(snapshots.values());
    }

    /**
     * 获取指定消息的快照信息。
     *
     * @param workspaceHash 项目 hash
     * @param sessionName   会话名称
     * @param msgId         消息 ID
     * @return 快照信息，不存在返回 null
     */
    public SnapshotInfo getSnapshot(String workspaceHash, String sessionName, String msgId) {
        String registryKey = buildRegistryKey(workspaceHash, sessionName);
        LinkedHashMap<String, SnapshotInfo> snapshots = snapshotRegistry.get(registryKey);
        if (snapshots == null) return null;
        return snapshots.get(msgId);
    }

    /**
     * 删除指定快照的 ref 引用。
     *
     * @param workspaceHash 项目 hash
     * @param msgId         消息 ID
     */
    public void deleteSnapshot(String workspaceHash, String msgId) {
        String workspacePath = resolveWorkspace(workspaceHash);
        File workspaceDir = new File(workspacePath);

        String refName = SNAPSHOT_REF_PREFIX + msgId;
        runGitSimple(workspaceDir, "update-ref", "-d", refName);

        // 从内存注册表中移除
        for (Map.Entry<String, LinkedHashMap<String, SnapshotInfo>> entry : snapshotRegistry.entrySet()) {
            entry.getValue().remove(msgId);
        }
    }

    /**
     * 检查项目是否为 Git 仓库。
     *
     * @param workspaceHash 项目 hash
     * @return 是否为 Git 仓库
     */
    public boolean isGitRepo(String workspaceHash) {
        try {
            String workspacePath = resolveWorkspace(workspaceHash);
            File workspaceDir = new File(workspacePath);
            ProcessResult check = runGit(workspaceDir, "git", "rev-parse", "--is-inside-work-tree");
            return check.exitCode == 0;
        } catch (Exception e) {
            return false;
        }
    }

    // ==================== 内部方法 ====================

    /**
     * 确认目录是 Git 仓库，否则抛出异常。
     */
    private void ensureGitRepo(File workspaceDir) {
        try {
            ProcessResult check = runGit(workspaceDir, "git", "rev-parse", "--is-inside-work-tree");
            if (check.exitCode != 0) {
                throw new ServiceException("当前项目不是 Git 仓库，无法创建快照");
            }
        } catch (ServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new ServiceException("Git 不可用: " + e.getMessage());
        }
    }

    /**
     * 注册快照到内存。
     */
    private void registerSnapshot(String workspaceHash, String msgId, SnapshotInfo info) {
        // 不确定 sessionName 时，使用 workspaceHash 作为 key
        String registryKey = buildRegistryKey(workspaceHash, null);
        snapshotRegistry.computeIfAbsent(registryKey, k -> new LinkedHashMap<>()).put(msgId, info);
    }

    /**
     * 截断指定消息之后的所有快照（撤回后，后续快照失效）。
     */
    public void discardSnapshotsAfter(String workspaceHash, String msgId) {
        String workspacePath = resolveWorkspace(workspaceHash);
        File workspaceDir = new File(workspacePath);

        for (Map.Entry<String, LinkedHashMap<String, SnapshotInfo>> entry : snapshotRegistry.entrySet()) {
            LinkedHashMap<String, SnapshotInfo> snapshots = entry.getValue();
            boolean found = false;
            Iterator<Map.Entry<String, SnapshotInfo>> it = snapshots.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, SnapshotInfo> snap = it.next();
                if (found) {
                    // 删除后续快照的 ref
                    String refName = SNAPSHOT_REF_PREFIX + snap.getKey();
                    runGitSimple(workspaceDir, "update-ref", "-d", refName);
                    it.remove();
                    log.debug("[snapshot] 截断快照: msgId={}", snap.getKey());
                }
                if (snap.getKey().equals(msgId)) {
                    found = true;
                    // 也删除当前快照的 ref（已回滚，快照不再需要）
                    String refName = SNAPSHOT_REF_PREFIX + msgId;
                    runGitSimple(workspaceDir, "update-ref", "-d", refName);
                    it.remove();
                }
            }
        }
    }

    /**
     * 构建内存注册表的 key。
     */
    private String buildRegistryKey(String workspaceHash, String sessionName) {
        if (sessionName != null && !sessionName.isEmpty()) {
            return workspaceHash + "::" + sessionName;
        }
        return workspaceHash;
    }

    private String resolveWorkspace(String workspaceHash) {
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        if (workspacePath == null) workspacePath = agentService.getCurrentProject();
        if (workspacePath == null) throw new ServiceException("未设置项目");
        return workspacePath;
    }

    /**
     * 简单 Git 命令执行 —— 用于只读查询。
     */
    private String runGitSimple(File dir, String... args) {
        try {
            List<String> cmd = new ArrayList<>();
            cmd.add("git");
            Collections.addAll(cmd, args);
            ProcessResult result = runGit(dir, cmd.toArray(new String[0]));
            return result.exitCode == 0 ? result.stdout.trim() : null;
        } catch (Exception e) {
            log.warn("[snapshot] Git 命令执行失败: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 增强 Git 命令执行 —— 带超时保护和终端交互禁用。
     * <p>
     * 与 {@code GitService.runGit} 同一模式：两个输出流并发消费，先超时判断再取输出，
     * 超时强杀进程并限长输出。超时判断若放在读流之后，流被阻塞时超时保护永远不生效。
     * </p>
     */
    private ProcessResult runGit(File workDir, String... command) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(workDir);
        pb.redirectErrorStream(false);
        pb.environment().put("GIT_TERMINAL_PROMPT", "0");

        Process proc = pb.start();
        Future<String> stdout = SNAPSHOT_IO_EXECUTOR.submit(() -> readStream(proc.getInputStream()));
        Future<String> stderr = SNAPSHOT_IO_EXECUTOR.submit(() -> readStream(proc.getErrorStream()));
        try {
            boolean finished = proc.waitFor(GIT_COMMAND_TIMEOUT_SEC, TimeUnit.SECONDS);
            if (!finished) {
                proc.destroyForcibly();
                proc.waitFor();
                return processResult(-1, "", "Command timed out after " + GIT_COMMAND_TIMEOUT_SEC + " seconds");
            }
            return processResult(proc.exitValue(), awaitOutput(stdout), awaitOutput(stderr));
        } finally {
            if (proc.isAlive()) {
                proc.destroyForcibly();
            }
            stdout.cancel(true);
            stderr.cancel(true);
        }
    }

    private ProcessResult processResult(int exitCode, String stdout, String stderr) {
        ProcessResult result = new ProcessResult();
        result.exitCode = exitCode;
        result.stdout = stdout;
        result.stderr = stderr;
        return result;
    }

    private String awaitOutput(Future<String> output) throws Exception {
        return output.get(GIT_OUTPUT_DRAIN_TIMEOUT_SEC, TimeUnit.SECONDS);
    }

    private String readStream(InputStream is) throws IOException {
        StringBuilder output = new StringBuilder();
        try (is) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = is.read(buffer)) != -1) {
                String chunk = new String(buffer, 0, read, StandardCharsets.UTF_8);
                int remaining = MAX_GIT_OUTPUT_CHARS - output.length();
                if (remaining > 0) {
                    output.append(chunk, 0, Math.min(remaining, chunk.length()));
                }
            }
        }
        if (output.length() >= MAX_GIT_OUTPUT_CHARS) {
            output.append("\n... (Git output truncated)");
        }
        return output.toString();
    }

    // ==================== 内部数据结构 ====================

    /**
     * 快照信息。
     */
    public static class SnapshotInfo {
        private final String msgId;
        private final String commitHash;
        private final String treeHash;
        private final long createdAt;

        public SnapshotInfo(String msgId, String commitHash, String treeHash, long createdAt) {
            this.msgId = msgId;
            this.commitHash = commitHash;
            this.treeHash = treeHash;
            this.createdAt = createdAt;
        }

        public String getMsgId() { return msgId; }
        public String getCommitHash() { return commitHash; }
        public String getTreeHash() { return treeHash; }
        public long getCreatedAt() { return createdAt; }
    }

    /**
     * 撤回结果。
     */
    public static class SnapshotRollbackResult {
        private final String msgId;
        private final String commitHash;
        private final String treeHash;
        private final boolean success;
        private String message;
        /**
         * 被删除的用户消息文本（用于前端回填输入框）
         */
        private String rollbackUserText;

        public SnapshotRollbackResult(String msgId, String commitHash, String treeHash, boolean success, String message) {
            this.msgId = msgId;
            this.commitHash = commitHash;
            this.treeHash = treeHash;
            this.success = success;
            this.message = message;
        }

        public String getMsgId() { return msgId; }
        public String getCommitHash() { return commitHash; }
        public String getTreeHash() { return treeHash; }
        public boolean isSuccess() { return success; }
        public String getMessage() {
            return message;
        }

        public void setMessage(String message) {
            this.message = message;
        }

        public String getRollbackUserText() {
            return rollbackUserText;
        }

        public void setRollbackUserText(String rollbackUserText) {
            this.rollbackUserText = rollbackUserText; }
    }

    /**
     * 进程执行结果。
     */
    private static class ProcessResult {
        int exitCode;
        String stdout;
        String stderr;
    }
}

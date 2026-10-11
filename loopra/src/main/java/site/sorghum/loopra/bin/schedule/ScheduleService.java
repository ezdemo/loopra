package site.sorghum.loopra.bin.schedule;

import lombok.extern.slf4j.Slf4j;

import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * 定时任务调度服务。
 * <p>
 * 职责：
 * <ul>
 *   <li>增删改查操作（委托给 {@link ScheduleStore}）</li>
 *   <li>定时扫描到期任务（ticker 模式，每 15 秒一次）</li>
 *   <li>将到期任务提交到工作线程池执行</li>
 * </ul>
 * </p>
 * <p>
 * 与 AgentService 的解耦通过 {@link TaskExecutor} 接口实现。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class ScheduleService {

    /** 调度 ticker 间隔（秒） */
    private static final int TICKER_INTERVAL_SEC = 15;

    /** 工作线程池大小 */
    private static final int WORKER_POOL_SIZE = 4;

    private final ScheduleStore store;
    private final TaskExecutor taskExecutor;

    /** 按项目索引的任务 Map：workspaceHash → (taskId → ScheduledTask) */
    private volatile Map<String, Map<String, ScheduledTask>> tasksIndex = new ConcurrentHashMap<>();

    /** 正在执行中的任务 ID 集合，用于防止重复提交 */
    private final Set<String> runningTaskIds = ConcurrentHashMap.newKeySet();

    /** 调度 ticker */
    private ScheduledExecutorService ticker;

    /** 工作线程池 */
    private ExecutorService workerPool;

    /** 是否正在运行 */
    private final AtomicBoolean running = new AtomicBoolean(false);

    public ScheduleService(ScheduleStore store, TaskExecutor taskExecutor) {
        this.store = store;
        this.taskExecutor = taskExecutor;
    }

    // ==================== 生命周期 ====================

    /**
     * 启动调度引擎。
     */
    public synchronized void start() {
        if (running.getAndSet(true)) return;
        log.info("[schedule] 调度引擎启动...");

        // 从磁盘加载所有任务
        store.reloadAll();
        rebuildIndex();

        // 启动 ticker
        this.ticker = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "schedule-ticker");
            t.setDaemon(true);
            return t;
        });

        this.workerPool = Executors.newFixedThreadPool(WORKER_POOL_SIZE, r -> {
            Thread t = new Thread(r, "schedule-worker");
            t.setDaemon(true);
            return t;
        });

        ticker.scheduleAtFixedRate(this::tick,
                TICKER_INTERVAL_SEC, TICKER_INTERVAL_SEC, TimeUnit.SECONDS);

        log.info("[schedule] 调度引擎已启动（ticker 间隔 {} 秒）", TICKER_INTERVAL_SEC);
    }

    /**
     * 停止调度引擎。
     */
    public synchronized void stop() {
        if (!running.getAndSet(false)) return;
        log.info("[schedule] 调度引擎停止...");

        if (ticker != null) {
            ticker.shutdown();
            try {
                ticker.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                ticker.shutdownNow();
            }
        }

        if (workerPool != null) {
            workerPool.shutdown();
            try {
                workerPool.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                workerPool.shutdownNow();
            }
        }

        log.info("[schedule] 调度引擎已停止");
    }

     // ==================== 增删改查 ====================

    /**
     * 列出指定项目的所有定时任务。
     */
    public List<ScheduledTask> list(String workspaceHash) {
        Map<String, ScheduledTask> tasks = tasksIndex.get(workspaceHash);
        if (tasks == null) return Collections.emptyList();
        return tasks.values().stream()
                .sorted(Comparator.comparingLong(ScheduledTask::getCreatedAt))
                .collect(Collectors.toList());
    }

    /**
     * 获取指定项目的单个定时任务。
     */
    public ScheduledTask get(String workspaceHash, String taskId) {
        Map<String, ScheduledTask> tasks = tasksIndex.get(workspaceHash);
        if (tasks == null) return null;
        return tasks.get(taskId);
    }

    /**
     * 创建定时任务。
     */
    public ScheduledTask create(String workspaceHash, ScheduledTask task) {
        if (task.getId() == null || task.getId().isBlank()) {
            task.setId(UUID.randomUUID().toString().replace("-", ""));
        }
        long now = System.currentTimeMillis();
        task.setCreatedAt(now);
        task.setUpdatedAt(now);
        task.setRunCount(0);
        task.setLastRunAt(0);

        // 计算首次执行时间
        task.setNextRunAt(task.computeNextRunAt());

        store.put(workspaceHash, task);
        rebuildIndex();
        return task;
    }

    /**
     * 更新定时任务。
     */
    public ScheduledTask update(String workspaceHash, String taskId, ScheduledTask update) {
        Map<String, ScheduledTask> tasks = tasksIndex.get(workspaceHash);
        if (tasks == null) return null;

        ScheduledTask existing = tasks.get(taskId);
        if (existing == null) return null;

        // 合并字段
        if (update.getName() != null) existing.setName(update.getName());
        if (update.getSessionName() != null) existing.setSessionName(update.getSessionName());
        if (update.getCronExpr() != null) existing.setCronExpr(update.getCronExpr());
        if (update.getIntervalSec() != null) existing.setIntervalSec(update.getIntervalSec());
        if (update.getMessage() != null) existing.setMessage(update.getMessage());
        existing.setEnabled(update.isEnabled());
        existing.setUpdatedAt(System.currentTimeMillis());

        // 重新计算下次执行时间
        existing.setNextRunAt(existing.computeNextRunAt());

        store.put(workspaceHash, existing);
        rebuildIndex();
        return existing;
    }

    /**
     * 启用/禁用定时任务。
     */
    public ScheduledTask toggle(String workspaceHash, String taskId) {
        Map<String, ScheduledTask> tasks = tasksIndex.get(workspaceHash);
        if (tasks == null) return null;

        ScheduledTask existing = tasks.get(taskId);
        if (existing == null) return null;

        existing.setEnabled(!existing.isEnabled());
        existing.setUpdatedAt(System.currentTimeMillis());
        if (existing.isEnabled()) {
            // 启用时重新计算下次执行时间
            existing.setNextRunAt(existing.computeNextRunAt());
        } else {
            existing.setNextRunAt(0);
        }

        store.put(workspaceHash, existing);
        rebuildIndex();
        return existing;
    }

    /**
     * 删除定时任务。
     */
    public void delete(String workspaceHash, String taskId) {
        store.remove(workspaceHash, taskId);
        rebuildIndex();
    }

    /**
     * 手动触发执行指定任务。
     *
     * @return 执行结果，null 表示任务不存在
     */
    public String runNow(String workspaceHash, String taskId) {
        Map<String, ScheduledTask> tasks = tasksIndex.get(workspaceHash);
        if (tasks == null) return null;

        ScheduledTask task = tasks.get(taskId);
        if (task == null) return null;

        String result = executeTask(workspaceHash, task);
        // 区分项目不存在和正常返回：executeTask 内部已处理
        return result != null ? result : "";
    }

    /**
     * 获取所有项目的 hash 列表（有定时任务的）。
     */
    public Set<String> getActiveWorkspaceHashes() {
        return tasksIndex.keySet();
    }

    // ==================== 内部方法 ====================

    /**
     * 重建内存索引（从 ScheduleStore 加载最新数据）。
     */
    private void rebuildIndex() {
        // 先清空缓存从磁盘加载最新数据
        store.reloadAll();
        Map<String, Map<String, ScheduledTask>> newIndex = new ConcurrentHashMap<>();
        for (String hash : store.getActiveWorkspaces()) {
            newIndex.put(hash, store.load(hash));
        }
        this.tasksIndex = newIndex;
    }

    /**
     * Ticker 周期任务：检查并执行到期的定时任务。
     */
    private void tick() {
        try {
            long now = System.currentTimeMillis();
            Map<String, Map<String, ScheduledTask>> snapshot = tasksIndex;

            for (Map.Entry<String, Map<String, ScheduledTask>> wsEntry : snapshot.entrySet()) {
                String workspaceHash = wsEntry.getKey();
                for (ScheduledTask task : wsEntry.getValue().values()) {
                    if (!task.isEnabled()) continue;
                    if (task.getNextRunAt() <= 0) continue;
                    if (task.getNextRunAt() > now) continue;

                    // 防止重复提交：如果任务正在执行则跳过
                    if (!runningTaskIds.add(task.getId())) continue;

                    // 到期任务提交到工作线程池
                    String taskId = task.getId();
                    workerPool.submit(() -> {
                        try {
                            executeTask(workspaceHash, task);
                        } catch (Exception e) {
                            log.warn("[schedule] 任务执行异常: {} - {}", task.getName(), e.getMessage());
                        } finally {
                            runningTaskIds.remove(taskId);
                        }
                    });
                }
            }
        } catch (Exception e) {
            log.warn("[schedule] ticker 异常: {}", e.getMessage());
        }
    }

    /**
     * 执行单个定时任务。
     *
     * @return 执行结果，空字符串表示项目不存在
     */
    private String executeTask(String workspaceHash, ScheduledTask task) {
        // 获取项目实际路径
        String workspacePath = resolveProjectPath(workspaceHash);
        if (workspacePath == null) {
            log.warn("[schedule] 找不到项目: {}", workspaceHash);
            return "";
        }

        log.info("[schedule] 执行定时任务: {} → 项目={}, 会话={}, 消息={}",
                task.getName(), workspaceHash, task.getSessionName(),
                task.getMessage() != null ? task.getMessage().substring(0, Math.min(50, task.getMessage().length())) : "");

        try {
            String result = taskExecutor.execute(workspacePath, task.getSessionName(), task.getMessage());

            // 更新任务状态
            long now = System.currentTimeMillis();
            task.setLastRunAt(now);
            task.setRunCount(task.getRunCount() + 1);
            task.setLastResult(result != null ? result.substring(0, Math.min(200, result.length())) : "");
            task.setLastError(null);
            task.setUpdatedAt(now);
            task.setNextRunAt(task.computeNextRunAt());

            store.put(workspaceHash, task);
            rebuildIndex();

            log.info("[schedule] 任务执行完成: {} (执行次数: {})", task.getName(), task.getRunCount());
            return result;
        } catch (Exception e) {
            log.warn("[schedule] 任务执行失败: {} - {}", task.getName(), e.getMessage());

            long now = System.currentTimeMillis();
            task.setLastRunAt(now);
            task.setLastError(e.getMessage());
            task.setUpdatedAt(now);
            task.setNextRunAt(task.computeNextRunAt());

            store.put(workspaceHash, task);
            rebuildIndex();
            return null;
        }
    }

    /**
     * 通过项目 hash 解析实际路径。
     * 从 ~/.loopra/workspace/{hash}/workspace.json 中读取 path 字段。
     */
    private String resolveProjectPath(String workspaceHash) {
        try {
            java.nio.file.Path configPath = java.nio.file.Paths.get(
                    System.getProperty("user.home"), ".loopra", "workspace",
                    workspaceHash, "workspace.json");
            if (java.nio.file.Files.exists(configPath)) {
                String json = java.nio.file.Files.readString(configPath);
                return org.noear.snack4.ONode.ofJson(json).get("path").getString();
            }
        } catch (Exception e) {
            log.warn("[schedule] 解析项目路径失败: {}", e.getMessage());
        }
        return null;
    }
}

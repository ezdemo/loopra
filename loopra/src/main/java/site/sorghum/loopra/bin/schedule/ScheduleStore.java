package site.sorghum.loopra.bin.schedule;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 定时任务持久化存储。
 * <p>
 * 按项目隔离存储，每个项目一个 JSON 文件：
 * {@code ~/.loopra/workspace/{hash}/schedules/schedules.json}
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class ScheduleStore {

    private static final Path BASE_DIR = Paths.get(
            System.getProperty("user.home"), ".loopra", "workspace");

    private final Path baseDir;
    private final Map<String, Map<String, ScheduledTask>> workspaceTasks = new ConcurrentHashMap<>();
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public ScheduleStore() {
        this(BASE_DIR);
    }

    ScheduleStore(Path baseDir) {
        this.baseDir = baseDir;
    }

    /**
     * 获取指定项目的调度文件路径。
     */
    private Path getScheduleFile(String workspaceHash) {
        return baseDir.resolve(workspaceHash).resolve("schedules").resolve("schedules.json");
    }

    /**
     * 加载指定项目的所有定时任务。
     *
     * @param workspaceHash 项目 hash
     * @return 任务列表（按 id 索引的 Map）
     */
    public Map<String, ScheduledTask> load(String workspaceHash) {
        lock.readLock().lock();
        try {
            Map<String, ScheduledTask> cached = workspaceTasks.get(workspaceHash);
            if (cached != null) {
                return new HashMap<>(cached);
            }
        } finally {
            lock.readLock().unlock();
        }

        // 缓存未命中，从磁盘加载
        lock.writeLock().lock();
        try {
            // 双重检查
            Map<String, ScheduledTask> cached = workspaceTasks.get(workspaceHash);
            if (cached != null) {
                return new HashMap<>(cached);
            }

            Path file = getScheduleFile(workspaceHash);
            Map<String, ScheduledTask> tasks = new LinkedHashMap<>();

            if (Files.exists(file)) {
                try {
                    String json = Files.readString(file, StandardCharsets.UTF_8);
                    ONode node = ONode.ofJson(json);
                    if (node.isArray()) {
                        for (ONode item : node.getArray()) {
                            ScheduledTask task = deserialize(item);
                            if (task != null && task.getId() != null) {
                                tasks.put(task.getId(), task);
                            }
                        }
                    }
                } catch (Exception e) {
                    log.warn("[schedule] 加载定时任务失败: {} - {}", workspaceHash, e.getMessage());
                }
            }

            workspaceTasks.put(workspaceHash, tasks);
            return new HashMap<>(tasks);
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * 持久化指定项目的所有定时任务。
     */
    public void save(String workspaceHash, Map<String, ScheduledTask> tasks) {
        lock.writeLock().lock();
        try {
            Path file = getScheduleFile(workspaceHash);
            try {
                Files.createDirectories(file.getParent());
            } catch (IOException e) {
                log.warn("[schedule] 创建目录失败: {}", e.getMessage());
            }

            ONode array = ONode.ofJson("[]").asArray();
            for (ScheduledTask task : tasks.values()) {
                array.add(serialize(task));
            }

            try {
                Files.writeString(file, array.toJson(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                log.warn("[schedule] 写入定时任务失败: {}", e.getMessage());
            }

            // 更新缓存
            workspaceTasks.put(workspaceHash, new LinkedHashMap<>(tasks));
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * 添加或更新一个定时任务。
     */
    public void put(String workspaceHash, ScheduledTask task) {
        Map<String, ScheduledTask> tasks = load(workspaceHash);
        tasks.put(task.getId(), task);
        save(workspaceHash, tasks);
    }

    /**
     * 删除一个定时任务。
     */
    public void remove(String workspaceHash, String taskId) {
        Map<String, ScheduledTask> tasks = load(workspaceHash);
        tasks.remove(taskId);
        save(workspaceHash, tasks);
    }

    /**
     * 获取所有项目 hash 列表（有定时任务的）。
     */
    public Set<String> getActiveWorkspaces() {
        lock.readLock().lock();
        try {
            return new HashSet<>(workspaceTasks.keySet());
        } finally {
            lock.readLock().unlock();
        }
    }

    /**
     * 从磁盘重新扫描所有项目的定时任务。
     */
    public void reloadAll() {
        lock.writeLock().lock();
        try {
            workspaceTasks.clear();
            if (Files.isDirectory(baseDir)) {
                try (java.nio.file.DirectoryStream<Path> ds = Files.newDirectoryStream(baseDir)) {
                    for (Path dir : ds) {
                        if (Files.isDirectory(dir)) {
                            String hash = dir.getFileName().toString();
                            Path scheduleFile = dir.resolve("schedules").resolve("schedules.json");
                            if (Files.exists(scheduleFile)) {
                                load(hash); // 触发缓存加载
                            }
                        }
                    }
                } catch (IOException e) {
                    log.warn("[schedule] 扫描项目目录失败: {}", e.getMessage());
                }
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    // ==================== 序列化 / 反序列化 ====================

    private ONode serialize(ScheduledTask task) {
        ONode node = ONode.ofJson("{}");
        if (task.getId() != null) node.set("id", task.getId());
        if (task.getName() != null) node.set("name", task.getName());
        if (task.getSessionName() != null) node.set("sessionName", task.getSessionName());
        if (task.getSessionMode() != null) node.set("sessionMode", task.getSessionMode());
        if (task.getCronExpr() != null) node.set("cronExpr", task.getCronExpr());
        if (task.getIntervalSec() != null) node.set("intervalSec", task.getIntervalSec());
        if (task.getMessage() != null) node.set("message", task.getMessage());
        node.set("enabled", task.isEnabled());
        node.set("lastRunAt", task.getLastRunAt());
        node.set("nextRunAt", task.getNextRunAt());
        node.set("runCount", task.getRunCount());
        if (task.getLastResult() != null) node.set("lastResult", task.getLastResult());
        if (task.getLastError() != null) node.set("lastError", task.getLastError());
        ONode runs = ONode.ofJson("[]").asArray();
        if (task.getRuns() != null) {
            for (ScheduleRun run : task.getRuns()) {
                ONode item = ONode.ofJson("{}");
                item.set("id", run.getId());
                item.set("startedAt", run.getStartedAt());
                item.set("finishedAt", run.getFinishedAt());
                item.set("status", run.getStatus());
                if (run.getMessage() != null) item.set("message", run.getMessage());
                if (run.getSessionName() != null) item.set("sessionName", run.getSessionName());
                if (run.getResult() != null) item.set("result", run.getResult());
                if (run.getError() != null) item.set("error", run.getError());
                runs.add(item);
            }
        }
        node.set("runs", runs);
        node.set("createdAt", task.getCreatedAt());
        node.set("updatedAt", task.getUpdatedAt());
        return node;
    }

    private ScheduledTask deserialize(ONode node) {
        try {
            ScheduledTask task = new ScheduledTask();
            task.setId(node.get("id").getString());
            task.setName(node.get("name").getString());
            task.setSessionName(node.get("sessionName").getString());
            task.setSessionMode(node.get("sessionMode").getString());
            task.setCronExpr(node.get("cronExpr").getString());
            ONode intervalNode = node.get("intervalSec");
            task.setIntervalSec(intervalNode.isNull() ? null : intervalNode.getLong());
            task.setMessage(node.get("message").getString());
            task.setEnabled(node.get("enabled").getBoolean());
            task.setLastRunAt(node.get("lastRunAt").getLong());
            task.setNextRunAt(node.get("nextRunAt").getLong());
            task.setRunCount(node.get("runCount").getLong().intValue());
            task.setLastResult(node.get("lastResult").getString());
            task.setLastError(node.get("lastError").getString());
            List<ScheduleRun> runs = new ArrayList<>();
            ONode runNodes = node.get("runs");
            if (runNodes.isArray()) {
                for (ONode item : runNodes.getArray()) {
                    ScheduleRun run = new ScheduleRun();
                    run.setId(item.get("id").getString());
                    run.setStartedAt(item.get("startedAt").getLong());
                    run.setFinishedAt(item.get("finishedAt").getLong());
                    run.setStatus(item.get("status").getString());
                    run.setMessage(item.get("message").getString());
                    run.setSessionName(item.get("sessionName").getString());
                    run.setResult(item.get("result").getString());
                    run.setError(item.get("error").getString());
                    runs.add(run);
                }
            }
            task.setRuns(runs);
            task.setCreatedAt(node.get("createdAt").getLong());
            task.setUpdatedAt(node.get("updatedAt").getLong());
            return task;
        } catch (Exception e) {
            log.warn("[schedule] 反序列化失败: {}", e.getMessage());
            return null;
        }
    }
}

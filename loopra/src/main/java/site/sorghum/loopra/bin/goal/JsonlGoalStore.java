package site.sorghum.loopra.bin.goal;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 每会话一个 JSON 快照的 Goal 存储。
 * 文件扩展名保留 .jsonl，兼容早期安装；内容始终是一条完整 JSON 记录。
 */
@Slf4j
public class JsonlGoalStore implements GoalStore {

    private static final ConcurrentHashMap<Path, ReentrantLock> LOCKS = new ConcurrentHashMap<>();
    private final Path goalsDir;

    public JsonlGoalStore(Path workspaceDir) {
        this.goalsDir = workspaceDir.resolve("goals");
    }

    @Override
    public void save(Goal goal) throws IOException {
        requireSessionId(goal == null ? null : goal.getSessionId());
        withSessionLock(goal.getSessionId(), () -> {
            saveUnlocked(goal);
            return null;
        });
    }

    @Override
    public Goal createIfNoOpenGoal(Goal goal) throws IOException {
        requireSessionId(goal == null ? null : goal.getSessionId());
        return withSessionLock(goal.getSessionId(), () -> {
            Goal existing = findBySessionUnlocked(goal.getSessionId());
            if (existing != null && existing.isOpen()) return existing;
            saveUnlocked(goal);
            return goal;
        });
    }

    @Override
    public Goal update(String sessionId, GoalMutation mutation) throws IOException {
        requireSessionId(sessionId);
        if (mutation == null) throw new IllegalArgumentException("Goal mutation 不能为空");
        return withSessionLock(sessionId, () -> {
            Goal goal = findBySessionUnlocked(sessionId);
            if (goal == null) throw new IllegalStateException("当前会话没有 Goal");
            mutation.apply(goal);
            saveUnlocked(goal);
            return goal;
        });
    }

    private void saveUnlocked(Goal goal) throws IOException {
        Files.createDirectories(goalsDir);
        Path target = fileFor(goal.getSessionId());
        Path temporary = Files.createTempFile(goalsDir, target.getFileName().toString(), ".tmp");
        try {
            Files.writeString(temporary, serializeGoal(goal) + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.TRUNCATE_EXISTING);
            try {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
            deleteMatchingLegacyFile(goal.getSessionId());
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    @Override
    public Goal findBySession(String sessionId) throws IOException {
        requireSessionId(sessionId);
        return withSessionLock(sessionId, () -> findBySessionUnlocked(sessionId));
    }

    private Goal findBySessionUnlocked(String sessionId) throws IOException {
        Path file = fileFor(sessionId);
        if (Files.exists(file)) return readGoal(file, sessionId);
        Path legacy = legacyFileFor(sessionId);
        return Files.exists(legacy) ? readLegacyGoal(legacy, sessionId) : null;
    }

    @Override
    public List<Goal> findActiveByWorkspace(String workspaceHash) throws IOException {
        Map<String, Goal> goals = new LinkedHashMap<>();
        if (!Files.isDirectory(goalsDir)) return new ArrayList<>();
        try (DirectoryStream<Path> files = Files.newDirectoryStream(goalsDir, "*.jsonl")) {
            for (Path file : files) {
                try {
                    String json = Files.readString(file, StandardCharsets.UTF_8).trim();
                    if (json.isEmpty()) continue;
                    Goal goal = deserializeGoal(json);
                    if ((workspaceHash == null || workspaceHash.equals(goal.getWorkspaceHash())) && goal.isOpen()) {
                        goals.put(goal.getSessionId(), goal);
                    }
                } catch (Exception e) {
                    log.warn("[goal] 忽略无法读取的目标快照 {}: {}", file, e.getMessage());
                }
            }
        }
        return new ArrayList<>(goals.values());
    }

    @Override
    public boolean delete(String sessionId) throws IOException {
        requireSessionId(sessionId);
        return withSessionLock(sessionId, () -> {
            boolean deleted = Files.deleteIfExists(fileFor(sessionId));
            Path legacy = legacyFileFor(sessionId);
            if (Files.exists(legacy)) {
                try {
                    Goal legacyGoal = readLegacyGoal(legacy, sessionId);
                    if (legacyGoal != null) deleted |= Files.deleteIfExists(legacy);
                } catch (IOException e) {
                    // 快照损坏时同样允许显式删除，避免会话被不可读文件锁死。
                    log.warn("[goal] 删除无法解析的旧目标快照 {}: {}", legacy, e.getMessage());
                    deleted |= Files.deleteIfExists(legacy);
                }
            }
            return deleted;
        });
    }

    static String serializeGoal(Goal goal) {
        ONode root = ONode.ofJson("{}");
        root.set("formatVersion", 2);
        root.set("id", goal.getId());
        root.set("sessionId", goal.getSessionId());
        root.set("workspaceHash", goal.getWorkspaceHash());
        root.set("title", goal.getTitle());
        root.set("description", goal.getDescription());
        root.set("status", goal.getStatus().name());
        root.set("verifyCommand", goal.getVerifyCommand());
        root.set("completionSummary", goal.getCompletionSummary());
        root.set("blockedReason", goal.getBlockedReason());
        setInstant(root, "createdAt", goal.getCreatedAt());
        setInstant(root, "updatedAt", goal.getUpdatedAt());
        setInstant(root, "completedAt", goal.getCompletedAt());

        ONode steps = root.getOrNew("steps").asArray();
        for (GoalStep step : goal.getSteps()) {
            ONode item = steps.addNew();
            item.set("index", step.getIndex());
            item.set("description", step.getDescription());
            item.set("status", step.getStatus().name());
            item.set("evidence", step.getEvidence());
            setInstant(item, "startedAt", step.getStartedAt());
            setInstant(item, "completedAt", step.getCompletedAt());
        }
        return root.toJson();
    }

    static Goal deserializeGoal(String json) {
        ONode root = ONode.ofJson(json);
        int formatVersion = root.get("formatVersion").getInt();
        if (formatVersion > 2) {
            throw new IllegalArgumentException("不支持的 Goal 快照版本: " + formatVersion);
        }
        Goal.GoalBuilder builder = Goal.builder()
                .id(root.get("id").getString())
                .sessionId(root.get("sessionId").getString())
                .workspaceHash(root.get("workspaceHash").getString())
                .title(root.get("title").getString())
                .description(root.get("description").getString())
                .status(parseGoalStatus(root.get("status").getString()))
                .verifyCommand(root.get("verifyCommand").getString())
                .completionSummary(root.get("completionSummary").getString())
                .blockedReason(root.get("blockedReason").getString())
                .createdAt(getInstant(root, "createdAt"))
                .updatedAt(getInstant(root, "updatedAt"))
                .completedAt(getInstant(root, "completedAt"));

        List<GoalStep> steps = new ArrayList<>();
        ONode items = root.get("steps");
        if (items.isArray()) {
            for (ONode item : items.getArray()) {
                steps.add(GoalStep.builder()
                        .index(item.get("index").getInt())
                        .description(item.get("description").getString())
                        .status(parseStepStatus(item.get("status").getString()))
                        .evidence(firstNonBlank(item.get("evidence").getString(), item.get("lastError").getString()))
                        .startedAt(getInstant(item, "startedAt"))
                        .completedAt(getInstant(item, "completedAt"))
                        .build());
            }
        }
        normalizeStepIndexes(steps, formatVersion);
        return builder.steps(steps).build();
    }

    private static void normalizeStepIndexes(List<GoalStep> steps, int formatVersion) {
        if (steps.isEmpty()) return;
        Set<Integer> indexes = new HashSet<>();
        for (GoalStep step : steps) {
            if (!indexes.add(step.getIndex())) {
                throw new IllegalArgumentException("Goal 步骤编号重复: " + step.getIndex());
            }
        }
        if (formatVersion < 2 && indexes.contains(0)) {
            for (int index = 0; index < steps.size(); index++) {
                if (!indexes.contains(index)) {
                    throw new IllegalArgumentException("旧 Goal 步骤编号不连续");
                }
            }
            steps.forEach(step -> step.setIndex(step.getIndex() + 1));
            return;
        }
        if (indexes.stream().anyMatch(index -> index < 1)) {
            throw new IllegalArgumentException("Goal 步骤编号必须从 1 开始");
        }
    }

    private Path fileFor(String sessionId) {
        String encoded = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(sessionId.getBytes(StandardCharsets.UTF_8));
        return goalsDir.resolve("v2-" + encoded + ".jsonl");
    }

    private Path legacyFileFor(String sessionId) {
        String safe = sessionId.replaceAll("[^a-zA-Z0-9_.-]", "_");
        return goalsDir.resolve(safe + ".jsonl");
    }

    private Goal readGoal(Path file, String expectedSessionId) throws IOException {
        Goal goal = readGoal(file);
        if (!expectedSessionId.equals(goal.getSessionId())) {
            throw new IOException("Goal 快照会话不匹配: " + file.getFileName());
        }
        return goal;
    }

    private Goal readLegacyGoal(Path file, String expectedSessionId) throws IOException {
        Goal goal = readGoal(file);
        return expectedSessionId.equals(goal.getSessionId()) ? goal : null;
    }

    private Goal readGoal(Path file) throws IOException {
        String json = Files.readString(file, StandardCharsets.UTF_8).trim();
        if (json.isEmpty()) throw new IOException("Goal 快照为空: " + file.getFileName());
        try {
            return deserializeGoal(json);
        } catch (RuntimeException e) {
            throw new IOException("无法解析 Goal 快照 " + file.getFileName(), e);
        }
    }

    private void deleteMatchingLegacyFile(String sessionId) throws IOException {
        Path legacy = legacyFileFor(sessionId);
        if (!Files.exists(legacy) || legacy.equals(fileFor(sessionId))) return;
        try {
            Goal goal = readLegacyGoal(legacy, sessionId);
            if (goal != null) Files.deleteIfExists(legacy);
        } catch (IOException e) {
            log.warn("[goal] 保留可能冲突的旧目标快照 {}: {}", legacy, e.getMessage());
        }
    }

    private <T> T withSessionLock(String sessionId, IoOperation<T> operation) throws IOException {
        ReentrantLock lock = lockFor(sessionId);
        lock.lock();
        try {
            Files.createDirectories(goalsDir);
            Path lockFile = goalsDir.resolve(fileFor(sessionId).getFileName() + ".lock");
            try (FileChannel channel = FileChannel.open(lockFile,
                    StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 var ignored = channel.lock()) {
                return operation.run();
            }
        } finally {
            lock.unlock();
        }
    }

    private ReentrantLock lockFor(String sessionId) {
        Path key = goalsDir.toAbsolutePath().normalize().resolve(fileFor(sessionId).getFileName());
        return LOCKS.computeIfAbsent(key, ignored -> new ReentrantLock());
    }

    @FunctionalInterface
    private interface IoOperation<T> {
        T run() throws IOException;
    }

    private static void requireSessionId(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("会话 ID 不能为空");
        }
    }

    private static void setInstant(ONode node, String key, Instant value) {
        if (value != null) node.set(key, value.toEpochMilli());
    }

    private static Instant getInstant(ONode node, String key) {
        ONode value = node.get(key);
        return value == null || value.isNull() ? null : Instant.ofEpochMilli(value.getLong());
    }

    private static GoalStatus parseGoalStatus(String value) {
        try {
            return GoalStatus.valueOf(value);
        } catch (Exception e) {
            throw new IllegalArgumentException("未知 Goal 状态: " + value, e);
        }
    }

    private static StepStatus parseStepStatus(String value) {
        if ("FAILED".equals(value)) return StepStatus.BLOCKED;
        try {
            return StepStatus.valueOf(value);
        } catch (Exception e) {
            throw new IllegalArgumentException("未知 Goal 步骤状态: " + value, e);
        }
    }

    private static String firstNonBlank(String first, String fallback) {
        return first != null && !first.isBlank() ? first : fallback;
    }
}

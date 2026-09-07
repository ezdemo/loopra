package site.sorghum.loopra.bin.session;

import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.util.ONodeUtil;
import site.sorghum.loopra.tool.interact.FinishTool;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/**
 * JSONL 格式会话持久化实现。
 * <p>
 * 文件位置：~/.loopra/workspace/{hash}/sessions/{name}.jsonl 或 ~/.loopra/sessions/{name}.jsonl
 * 格式：每行一个 JSON 格式的消息对象。
 * </p>
 * <p>
 * 使用 {@link BufferedWriter} 保持文件打开，避免每次写入打开/关闭文件。
 * 每条消息同步写入并立即 flush（来一条落一条），append 返回即已持久化，
 * 进程崩溃/强制退出不丢已确认的消息；消息粒度写入开销小，可接受。
 * {@link #flush()} 保留为幂等兜底，兼容接口契约。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class JsonlSessionStore implements SessionStore {

    private static final Path DEFAULT_SESSIONS_DIR = Paths.get(
            System.getProperty("user.home"), ".loopra", "sessions");
    /** 进程内按会话文件分片的读写锁，保护独立 Store 实例间的并发访问。 */
    private static final ReentrantLock[] FILE_LOCKS = new ReentrantLock[64];

    static {
        Arrays.setAll(FILE_LOCKS, ignored -> new ReentrantLock());
    }
    /**
     * 当前会话目录（支持项目隔离）
     */
    private final Path sessionsDir;
    /**
     * 线程同步锁
     */
    private final ReentrantLock lock = new ReentrantLock();
    /**
     * 当前会话名
     */
    private String currentName;
    /**
     * 当前会话的 BufferedWriter（保持打开）
     */
    private BufferedWriter writer;
    /**
     * 当前会话原始事件日志的 BufferedWriter（append-only 审计，压缩重写不触碰）
     */
    private BufferedWriter eventWriter;
    /**
     * 当前会话文件路径（用于 rewrite 时重新打开）
     */
    private Path currentFile;
    /**
     * 当前会话事件日志路径
     */
    private Path currentEventFile;

    /**
     * 默认构造函数，使用默认会话目录
     */
    public JsonlSessionStore() throws IOException {
        this(DEFAULT_SESSIONS_DIR);
    }

    /**
     * 指定会话目录的构造函数（支持项目隔离）
     *
     * @param sessionsDir 会话目录路径
     */
    @SneakyThrows
    public JsonlSessionStore(Path sessionsDir){
        this.sessionsDir = sessionsDir;
        Files.createDirectories(sessionsDir);
        // 不自动分配会话名 —— 等用户主动选择或首次写入时才确定
        this.currentName = null;
        this.writer = null;
    }

    // ---- 文件管理 ----

    private static String sanitize(String name) {
        return name.replaceAll("[^\\p{L}\\p{N}_\\-\\[\\]]", "_");
    }

    private static ReentrantLock fileLock(Path file) {
        int index = Math.floorMod(file.toAbsolutePath().normalize().hashCode(), FILE_LOCKS.length);
        return FILE_LOCKS[index];
    }

    public static String serializeMessage(ChatMessage msg) {
        org.noear.snack4.ONode node = org.noear.snack4.ONode.ofJson("{}");
        node.set("role", msg.getRole());
        // 多模态 contentParts 优先序列化为 JSON array（与 OpenAI API 格式一致）
        if (msg.getContentParts() != null && !msg.getContentParts().isEmpty()) {
            org.noear.snack4.ONode contentArr = node.getOrNew("content").asArray();
            for (ChatMessage.ContentPart part : msg.getContentParts()) {
                org.noear.snack4.ONode partNode = contentArr.addNew();
                partNode.set("type", part.getType());
                if ("text".equals(part.getType())) {
                    partNode.set("text", part.getText() != null ? part.getText() : "");
                } else if ("image_url".equals(part.getType())) {
                    ChatMessage.ContentPart.ImageUrl iu = part.getImageUrl();
                    if (iu != null) {
                        org.noear.snack4.ONode urlNode = partNode.getOrNew("image_url");
                        urlNode.set("url", iu.getUrl() != null ? iu.getUrl() : "");
                        if (iu.getDetail() != null) urlNode.set("detail", iu.getDetail());
                    }
                }
            }
        } else if (msg.getContent() != null) {
            node.set("content", msg.getContent());
        }
        if (msg.getReasoningContent() != null) {
            node.set("reasoning_content", msg.getReasoningContent());
        }
        if (msg.getResponseReasoning() != null) {
            node.set("response_reasoning", msg.getResponseReasoning());
        }
        if (msg.getFileChanges() != null && !msg.getFileChanges().isEmpty()) {
            org.noear.snack4.ONode changes = node.getOrNew("file_changes").asArray();
            for (FileChange change : msg.getFileChanges()) {
                org.noear.snack4.ONode item = changes.addNew().asObject();
                item.set("path", change.path());
                item.set("additions", change.additions());
                item.set("deletions", change.deletions());
                item.set("created", change.created());
                item.set("diff", change.diff());
            }
        }
        if (msg.getSnapshotId() != null) {
            node.set("snapshot_id", msg.getSnapshotId());
        }
        if (msg.getRollbackId() != null) {
            node.set("rollback_id", msg.getRollbackId());
        }
        if (msg.isWebHidden()) {
            node.set("web_hidden", true);
        }
        if (msg.getTimestamp() != null) {
            node.set("timestamp", msg.getTimestamp());
        }
        if (msg.getTurnStartedAt() != null) {
            node.set("turn_started_at", msg.getTurnStartedAt());
        }
        if (msg.getTurnFinishedAt() != null) {
            node.set("turn_finished_at", msg.getTurnFinishedAt());
        }
        if (msg.getElapsedMs() != null) {
            node.set("elapsed_ms", msg.getElapsedMs());
        }
        if (msg.getToolStartedAt() != null) {
            node.set("tool_started_at", msg.getToolStartedAt());
        }
        if (msg.getToolFinishedAt() != null) {
            node.set("tool_finished_at", msg.getToolFinishedAt());
        }
        if (msg.getToolDurationMs() != null) {
            node.set("tool_duration_ms", msg.getToolDurationMs());
        }
        if (msg.getToolCallId() != null) {
            node.set("tool_call_id", msg.getToolCallId());
        }
        if (msg.getToolImageUrl() != null) {
            node.set("tool_image_url", msg.getToolImageUrl());
        }
        if (msg.getToolImageDetail() != null) {
            node.set("tool_image_detail", msg.getToolImageDetail());
        }
        if (msg.hasToolCalls()) {
            org.noear.snack4.ONode tcArr = node.getOrNew("tool_calls").asArray();
            for (ToolCallEntry tc : msg.getToolCalls()) {
                org.noear.snack4.ONode tcn = tcArr.addNew();
                tcn.set("id", tc.id() != null ? tc.id() : "unknown");
                tcn.set("type", "function");
                org.noear.snack4.ONode func = tcn.getOrNew("function");
                func.set("name", tc.name() != null ? tc.name() : "unknown");
                Object tcArgs = tc.arguments();
                String argsStr = "{}";
                if (tcArgs != null) {
                    if (tcArgs instanceof String) {
                        argsStr = (String) tcArgs;
                    } else {
                        argsStr = org.noear.snack4.ONode.serialize(tcArgs);
                    }
                }
                func.set("arguments", argsStr);
            }
        }
        return node.toJson();
    }

    /**
     * 打开（或重新打开）当前会话的 BufferedWriter
     */
    private void openWriter() throws IOException {
        closeWriter();
        this.currentFile = sessionPath(currentName);
        this.currentEventFile = eventPath(currentName);
        Files.createDirectories(currentFile.getParent());
        this.writer = Files.newBufferedWriter(currentFile, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        this.eventWriter = Files.newBufferedWriter(currentEventFile, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    // ---- 写入辅助 ----

    /**
     * 确保 writer 已打开，若未打开则按需创建文件和 writer。
     * 延迟创建：仅在首次写入消息时才真正创建 .jsonl 文件，
     * 避免空白会话产生空文件。
     */
    private void ensureWriter() throws IOException {
        if (writer == null) {
            this.currentFile = sessionPath(currentName);
            this.currentEventFile = eventPath(currentName);
            Files.createDirectories(currentFile.getParent());
            this.writer = Files.newBufferedWriter(currentFile, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            this.eventWriter = Files.newBufferedWriter(currentEventFile, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        }
    }

    /**
     * 关闭当前 writer（刷入后关闭）
     */
    private void closeWriter() {
        lock.lock();
        try {
            if (writer != null) {
                ReentrantLock fileIoLock = fileLock(currentFile);
                fileIoLock.lock();
                try {
                    try {
                        writer.flush();
                    } catch (IOException e) {
                        log.warn("[jsonl] flush 关闭前失败: {}", e.getMessage());
                    }
                    try {
                        writer.close();
                    } catch (IOException e) {
                        log.warn("[jsonl] close 关闭前失败: {}", e.getMessage());
                    }
                    writer = null;
                } finally {
                    fileIoLock.unlock();
                }
            }
            if (eventWriter != null) {
                ReentrantLock eventFileIoLock = fileLock(currentEventFile);
                eventFileIoLock.lock();
                try {
                    try {
                        eventWriter.flush();
                    } catch (IOException e) {
                        log.warn("[jsonl] 事件日志 flush 关闭前失败: {}", e.getMessage());
                    }
                    try {
                        eventWriter.close();
                    } catch (IOException e) {
                        log.warn("[jsonl] 事件日志 close 关闭前失败: {}", e.getMessage());
                    }
                    eventWriter = null;
                } finally {
                    eventFileIoLock.unlock();
                }
            }
        } finally {
            lock.unlock();
        }
    }

    // ---- SessionStore 接口实现 ----

    /**
     * 关闭 store，释放文件句柄。
     * 同步写入模式下无后台线程/定时器，仅需关闭 writer。
     * 调用后不能再使用此 store 实例。
     */
    @Override
    public void shutdown() {
        closeWriter();
    }

    @Override
    public String currentName() {
        return currentName;
    }

    @Override
    public String newSessionName() {
        String ts = new SimpleDateFormat("yyyyMMddHHmm").format(new Date());
        return "loopra-" + ts;
    }

    @Override
    public boolean bindTo(String name) {
        if (name == null || name.isEmpty()) return false;
        flush();
        lock.lock();
        try {
            // 关闭旧 writer，不创建新文件——延迟到首次 append 时创建
            closeWriter();
            this.currentName = sanitize(name);
            return true;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void append(ChatMessage message) throws IOException {
        lock.lock();
        try {
            if (currentName == null) {
                currentName = newSessionName();
            }
            ensureWriter();
            ReentrantLock fileIoLock = fileLock(currentFile);
            fileIoLock.lock();
            try {
                writer.write(serializeMessage(message));
                writer.newLine();
                // 来一条落一条：立即推向文件，append 返回即已持久化，进程崩溃不丢消息
                writer.flush();
            } finally {
                fileIoLock.unlock();
            }
            ReentrantLock eventFileIoLock = fileLock(currentEventFile);
            eventFileIoLock.lock();
            try {
                eventWriter.write(serializeMessage(message));
                eventWriter.newLine();
                eventWriter.flush();
            } catch (IOException e) {
                log.warn("[jsonl] 原始事件日志写入失败: {}", e.getMessage());
            } finally {
                eventFileIoLock.unlock();
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void flush() {
        // 同步写入模式下 append 已即时刷盘，此处仅做防御性兜底（幂等）
        lock.lock();
        try {
            if (writer != null) {
                ReentrantLock fileIoLock = fileLock(currentFile);
                fileIoLock.lock();
                try {
                    writer.flush();
                } finally {
                    fileIoLock.unlock();
                }
            }
            if (eventWriter != null) {
                ReentrantLock eventFileIoLock = fileLock(currentEventFile);
                eventFileIoLock.lock();
                try {
                    eventWriter.flush();
                } finally {
                    eventFileIoLock.unlock();
                }
            }
        } catch (IOException e) {
            log.error("[jsonl] flush 失败: {}", e.getMessage());
        } finally {
            lock.unlock();
        }
    }

    @Override
    public List<ChatMessage> load() throws IOException {
        lock.lock();
        try {
            if (currentName == null) return new ArrayList<>();
            return load(currentName);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public List<ChatMessage> load(String name) throws IOException {
        lock.lock();
        try {
            Path file = sessionPath(name);
            ReentrantLock fileIoLock = fileLock(file);
            fileIoLock.lock();
            try {
                if (!Files.exists(file)) return new ArrayList<>();
                List<ChatMessage> messages = new ArrayList<>();
                for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("//")) continue;
                    try {
                        ONode node = ONode.ofJson(line);
                        messages.add(ChatMessage.fromMap(ONodeUtil.toMap(node)));
                    } catch (Exception e) {
                        log.warn("[jsonl] 解析消息行失败: {}", e.getMessage());
                    }
                }
                messages = messages.stream().filter(
                        it -> !(it.isUser() && Objects.equals(FinishTool.TIPS,it.getContent()))
                ).toList();
                return messages;
            } finally {
                fileIoLock.unlock();
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public List<ChatMessage> loadEvents(String name) throws IOException {
        lock.lock();
        try {
            Path file = eventPath(name);
            ReentrantLock fileIoLock = fileLock(file);
            fileIoLock.lock();
            try {
                if (!Files.exists(file)) return new ArrayList<>();
                List<ChatMessage> messages = new ArrayList<>();
                for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("//")) continue;
                    try {
                        ONode node = ONode.ofJson(line);
                        messages.add(ChatMessage.fromMap(ONodeUtil.toMap(node)));
                    } catch (Exception e) {
                        log.warn("[jsonl] 解析事件日志行失败: {}", e.getMessage());
                    }
                }
                return messages;
            } finally {
                fileIoLock.unlock();
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void rewrite(List<ChatMessage> messages) throws IOException {
        flush();
        lock.lock();
        try {
            // 关闭当前 writer
            Path file = sessionPath(currentName);
            ReentrantLock fileIoLock = fileLock(file);
            fileIoLock.lock();
            try {
                closeWriter();
                // 写入临时文件，然后替换
                Files.createDirectories(file.getParent());
                Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
                try (BufferedWriter w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                    for (ChatMessage m : messages) {
                        w.write(serializeMessage(m));
                        w.newLine();
                    }
                    w.flush();
                }
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
                // 重新打开 writer
                openWriter();
            } finally {
                fileIoLock.unlock();
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public List<SessionInfo> list() throws IOException {
        if (!Files.isDirectory(sessionsDir)) return new ArrayList<>();
        List<SessionInfo> list = new ArrayList<>();
        Set<String> listedNames = new HashSet<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(sessionsDir, "*.jsonl")) {
            for (Path p : ds) {
                String name = p.getFileName().toString().replace(".jsonl", "");
                if (name.contains("__archive")) continue;
                BasicFileAttributes attr = Files.readAttributes(p, BasicFileAttributes.class);
                long size = attr.size();
                long lines = 0;
                try (BufferedReader r = Files.newBufferedReader(p, StandardCharsets.UTF_8)) {
                    while (r.readLine() != null) lines++;
                }
                // 读取标题与隔离分支模式
                String title = null;
                boolean worktreeMode = false;
                Path metaFile = sessionsDir.resolve(sanitize(name) + ".meta");
                if (Files.exists(metaFile)) {
                    try {
                        String metaJson = Files.readString(metaFile);
                        org.noear.snack4.ONode metaNode = org.noear.snack4.ONode.ofJson(metaJson);
                        title = metaNode.get("title").getString();
                        worktreeMode = worktreeModeOf(metaNode);
                    } catch (Exception e) {
                        log.warn("[jsonl] 读取会话元数据失败: {}", e.getMessage());
                    }
                }
                list.add(new SessionInfo(name, size, lines, attr.lastModifiedTime().toMillis(), title, worktreeMode));
                listedNames.add(name);
            }
        }
        // 计划模式可在首条消息前开启，此时只有 .meta；仍需让会话可被刷新后重新发现。
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(sessionsDir, "*.meta")) {
            for (Path p : ds) {
                String name = p.getFileName().toString().replace(".meta", "");
                if (listedNames.contains(name) || name.contains("__archive")) continue;
                try {
                    ONode meta = ONode.ofJson(Files.readString(p));
                    boolean planMode = meta.get("planMode").getBoolean();
                    String pendingPlan = meta.get("pendingPlan").getString();
                    if (!planMode && (pendingPlan == null || pendingPlan.isBlank())) continue;
                    String title = meta.get("title").getString();
                    BasicFileAttributes attr = Files.readAttributes(p, BasicFileAttributes.class);
                    list.add(new SessionInfo(name, 0, 0, attr.lastModifiedTime().toMillis(), title, worktreeModeOf(meta)));
                } catch (Exception e) {
                    log.warn("[jsonl] 读取计划会话元数据失败 {}: {}", p.getFileName(), e.getMessage());
                }
            }
        }
        list.sort((a, b) -> Long.compare(b.mtime(), a.mtime()));
        return list;
    }

    @Override
    public boolean delete(String name) throws IOException {
        flush();
        String safe = sanitize(name);
        Path jsonl = sessionsDir.resolve(safe + ".jsonl");
        Path usage = sessionsDir.resolve(safe + ".usage");
        Path meta = sessionsDir.resolve(safe + ".meta");
        Path events = sessionsDir.resolve(safe + ".events");
        boolean deleted = Files.deleteIfExists(jsonl);
        deleted |= Files.deleteIfExists(usage);
        deleted |= Files.deleteIfExists(meta);
        deleted |= Files.deleteIfExists(events);
        return deleted;
    }

    @SneakyThrows
    @Override
    public void clearAll(){
        flush();
        if (!Files.isDirectory(sessionsDir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(sessionsDir)) {
            for (Path p : ds) {
                String name = p.getFileName().toString();
                // 只删除会话相关文件：.jsonl / .usage / .meta / .model_usage / .events
                if (name.endsWith(".jsonl") || name.endsWith(".usage")
                        || name.endsWith(".meta") || name.endsWith(".model_usage")
                        || name.endsWith(".events")) {
                    try {
                        Files.deleteIfExists(p);
                    } catch (IOException e) {
                        log.warn("[jsonl] 删除文件失败 {}: {}", name, e.getMessage());
                    }
                }
            }
        }
        // 重置当前会话状态
        currentName = null;
        closeWriter();
    }

    @Override
    public void saveUsage(String name, long prompt, long completion, long cacheHit, long cacheMiss) throws IOException {
        saveUsage(name, prompt, completion, cacheHit, cacheMiss, 0);
    }

    @Override
    public void saveUsage(String name, long prompt, long completion,
                          long cacheHit, long cacheMiss, long lastPromptTokens) throws IOException {
        Path file = sessionsDir.resolve(sanitize(name) + ".usage");

        // 如果所有值都是 0，则删除文件（如果存在），避免创建空文件
        if (prompt == 0 && completion == 0 && cacheHit == 0 && cacheMiss == 0) {
            Files.deleteIfExists(file);
            return;
        }

        org.noear.snack4.ONode node = org.noear.snack4.ONode.ofJson("{}").asObject();
        node.set("prompt", prompt);
        node.set("completion", completion);
        node.set("cacheHit", cacheHit);
        node.set("cacheMiss", cacheMiss);
        node.set("lastPromptTokens", lastPromptTokens);
        Files.writeString(file, node.toJson());
    }

    @Override
    public void updateTitle(String name, String title) throws IOException {
        writeMeta(name, node -> node.set("title", title));
    }

    @Override
    public String getTitle(String name) {
        org.noear.snack4.ONode meta = readMeta(name);
        return meta != null ? meta.get("title").getString() : null;
    }

    @Override
    public void setPlanMode(String name, boolean enabled) {
        try {
            writeMeta(name, node -> node.set("planMode", enabled));
        } catch (IOException e) {
            log.warn("[jsonl] 持久化计划模式失败: {}", e.getMessage());
        }
    }

    @Override
    public boolean isPlanMode(String name) {
        org.noear.snack4.ONode meta = readMeta(name);
        if (meta == null) return false;
        org.noear.snack4.ONode flag = meta.get("planMode");
        return flag != null && !flag.isNull() && flag.getBoolean();
    }

    @Override
    public void setPendingPlan(String name, String plan) {
        try {
            writeMeta(name, node -> {
                if (plan == null || plan.isBlank()) {
                    node.remove("pendingPlan");
                } else {
                    node.set("pendingPlan", plan);
                }
            });
        } catch (IOException e) {
            log.warn("[jsonl] 持久化待审查计划失败: {}", e.getMessage());
        }
    }

    @Override
    public String getPendingPlan(String name) {
        org.noear.snack4.ONode meta = readMeta(name);
        if (meta == null) return null;
        String plan = meta.get("pendingPlan").getString();
        return plan == null || plan.isBlank() ? null : plan;
    }

    @Override
    public void setWorktreeMode(String name, boolean enabled) {
        try {
            writeMeta(name, node -> node.set("worktreeMode", enabled));
        } catch (IOException e) {
            log.warn("[jsonl] 持久化隔离分支模式失败: {}", e.getMessage());
        }
    }

    @Override
    public boolean isWorktreeMode(String name) {
        org.noear.snack4.ONode meta = readMeta(name);
        if (meta == null) return false;
        org.noear.snack4.ONode flag = meta.get("worktreeMode");
        return flag != null && !flag.isNull() && flag.getBoolean();
    }

    @Override
    public void setMergeMode(String name, String mode) {
        try {
            if (mode == null || mode.isBlank()) {
                writeMeta(name, node -> node.remove("mergeMode"));
            } else {
                writeMeta(name, node -> node.set("mergeMode", mode.trim()));
            }
        } catch (IOException e) {
            log.warn("[jsonl] 持久化隔离分支合并模式失败: {}", e.getMessage());
        }
    }

    @Override
    public String getMergeMode(String name) {
        org.noear.snack4.ONode meta = readMeta(name);
        if (meta == null) return "manual";
        String mode = meta.get("mergeMode").getString();
        return mode == null || mode.isBlank() ? "manual" : mode;
    }

    @Override
    public SessionModelSettings getModelSettings(String name) {
        org.noear.snack4.ONode meta = readMeta(name);
        if (meta == null) return new SessionModelSettings(null, null, null);
        return new SessionModelSettings(
                metaString(meta, "model"),
                metaString(meta, "modelChannelId"),
                metaString(meta, "reasoningEffort"));
    }

    @Override
    public void setModelSettings(String name, String model, String modelChannelId,
                                 String reasoningEffort) {
        try {
            writeMeta(name, node -> {
                setMetaString(node, "model", model);
                setMetaString(node, "modelChannelId", modelChannelId);
                setMetaString(node, "reasoningEffort", reasoningEffort);
            });
        } catch (IOException e) {
            log.warn("[jsonl] 持久化会话模型设置失败: {}", e.getMessage());
        }
    }

    private static String metaString(org.noear.snack4.ONode meta, String key) {
        if (meta == null) return null;
        org.noear.snack4.ONode valueNode = meta.get(key);
        if (valueNode == null || valueNode.isNull()) return null;
        String value = valueNode.getString();
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static void setMetaString(org.noear.snack4.ONode meta, String key, String value) {
        if (value == null || value.isBlank()) {
            meta.remove(key);
        } else {
            meta.set(key, value.trim());
        }
    }

    /** 从已解析的 .meta 节点读取隔离分支模式标记（兼容缺失/非布尔字段）。 */
    private static boolean worktreeModeOf(org.noear.snack4.ONode meta) {
        if (meta == null) return false;
        org.noear.snack4.ONode flag = meta.get("worktreeMode");
        return flag != null && !flag.isNull() && flag.getBoolean();
    }

    /**
     * 读取会话 .meta JSON（不存在或解析失败返回 null）。
     */
    private org.noear.snack4.ONode readMeta(String name) {
        Path file = sessionsDir.resolve(sanitize(name) + ".meta");
        if (!Files.exists(file)) return null;
        ReentrantLock metaLock = fileLock(file);
        metaLock.lock();
        try {
            if (!Files.exists(file)) return null;
            return org.noear.snack4.ONode.ofJson(Files.readString(file));
        } catch (Exception e) {
            log.warn("[jsonl] 读取会话元数据失败: {}", e.getMessage());
            return null;
        } finally {
            metaLock.unlock();
        }
    }

    /**
     * 读-改-写会话 .meta JSON，保留已有字段（title 与 planMode 共存）。
     */
    private void writeMeta(String name, java.util.function.Consumer<org.noear.snack4.ONode> modifier) throws IOException {
        Path file = sessionsDir.resolve(sanitize(name) + ".meta");
        ReentrantLock metaLock = fileLock(file);
        metaLock.lock();
        Path temp = null;
        try {
            org.noear.snack4.ONode node = readMeta(name);
            if (node == null || !node.isObject()) {
                node = org.noear.snack4.ONode.ofJson("{}").asObject();
            }
            modifier.accept(node);
            temp = Files.createTempFile(sessionsDir, sanitize(name) + "-", ".meta.tmp");
            Files.writeString(temp, node.toJson());
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
            temp = null;
        } finally {
            if (temp != null) Files.deleteIfExists(temp);
            metaLock.unlock();
        }
    }

    @Override
    public long[] loadUsage(String name) {
        Path file = sessionsDir.resolve(sanitize(name) + ".usage");
        if (!Files.exists(file)) return new long[]{0, 0, 0, 0, 0};
        try {
            String json = Files.readString(file);
            org.noear.snack4.ONode node = org.noear.snack4.ONode.ofJson(json);
            return new long[]{
                    node.get("prompt").getLong(),
                    node.get("completion").getLong(),
                    node.get("cacheHit").getLong(),
                    node.get("cacheMiss").getLong(),
                    node.get("lastPromptTokens").getLong()
            };
        } catch (Exception e) {
            return new long[]{0, 0, 0, 0, 0};
        }
    }

    // ---- 内部辅助 ----

    @Override
    public void saveModelUsage(String name, Map<String, long[]> modelUsage) throws IOException {
        if (modelUsage == null || modelUsage.isEmpty()) {
            // 删除文件（如果存在）
            Path file = sessionsDir.resolve(sanitize(name) + ".model_usage");
            Files.deleteIfExists(file);
            return;
        }
        org.noear.snack4.ONode root = org.noear.snack4.ONode.ofJson("{}").asObject();
        for (Map.Entry<String, long[]> entry : modelUsage.entrySet()) {
            long[] mu = entry.getValue();
            org.noear.snack4.ONode arr = root.getOrNew(entry.getKey()).asArray();
            arr.clear();
            for (long v : mu) {
                arr.add(v);
            }
        }
        Path file = sessionsDir.resolve(sanitize(name) + ".model_usage");
        Files.writeString(file, root.toJson());
    }

    @Override
    public Map<String, long[]> loadModelUsage(String name) {
        Map<String, long[]> result = new LinkedHashMap<>();
        Path file = sessionsDir.resolve(sanitize(name) + ".model_usage");
        if (!Files.exists(file)) return result;
        try {
            String json = Files.readString(file);
            org.noear.snack4.ONode root = org.noear.snack4.ONode.ofJson(json);
            for (Map.Entry<String, org.noear.snack4.ONode> entry : root.getObject().entrySet()) {
                org.noear.snack4.ONode arr = entry.getValue();
                if (arr.isArray() && !arr.getArray().isEmpty()) {
                    long[] mu = new long[Math.min(arr.getArray().size(), 4)];
                    for (int i = 0; i < mu.length; i++) {
                        mu[i] = arr.getArray().get(i).getLong();
                    }
                    result.put(entry.getKey(), mu);
                }
            }
        } catch (Exception e) {
            return result;
        }
        return result;
    }

    private Path sessionPath(String name) {
        return sessionsDir.resolve(sanitize(name) + ".jsonl");
    }

    private Path eventPath(String name) {
        return sessionsDir.resolve(sanitize(name) + ".events");
    }

    // ---- 每日用量日志（全局共享） ----

    private static final Path DAILY_USAGE_FILE = Paths.get(
            System.getProperty("user.home"), ".loopra", "usage_daily.jsonl");

    private static final java.util.concurrent.locks.ReentrantLock DAILY_LOCK =
            new java.util.concurrent.locks.ReentrantLock();

    @Override
    public void appendDailyUsage(String model, int prompt, int completion,
                                 int cacheHit, int cacheMiss) {
        if (prompt == 0 && completion == 0) return;
        DAILY_LOCK.lock();
        try {
            Files.createDirectories(DAILY_USAGE_FILE.getParent());
            String modelName = model != null ? model.replace("\\", "\\\\").replace("\"", "\\\"") : "unknown";
            String line = "{\"ts\":" + System.currentTimeMillis()
                    + ",\"model\":\"" + modelName + "\""
                    + ",\"prompt\":" + prompt
                    + ",\"completion\":" + completion
                    + ",\"cacheHit\":" + cacheHit
                    + ",\"cacheMiss\":" + cacheMiss + "}\n";
            Files.writeString(DAILY_USAGE_FILE, line,
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.debug("[usage] 写入每日用量日志失败: {}", e.getMessage());
        } finally {
            DAILY_LOCK.unlock();
        }
    }
}

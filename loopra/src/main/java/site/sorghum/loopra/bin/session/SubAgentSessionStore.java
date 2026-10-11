package site.sorghum.loopra.bin.session;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.util.ONodeUtil;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 子代理会话存储 —— 将子代理执行过程以 JSONL 落盘，挂在主代理会话之下（父子级）。
 * <p>
 * 文件位置：{sessionsDir}/{sanitize(父会话名)}.sub/{subSessionId}.jsonl
 * 每行一个与 SSE 一致的 sub_* 事件 JSON；首行为 sub_start（含 task/profile/时间等元数据），
 * 末行为 sub_end（含状态）。JsonlSessionStore 的 list/delete/clearAll 只处理固定扩展名的
 * 顶层文件，.sub 子目录天然隔离：既不会混入主会话列表，也不会被主会话删除误伤
 * （级联清理由 {@code AgentService} 显式调用 {@link #deleteParent}/{@link #deleteAll}）。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class SubAgentSessionStore {

    /** 子代理会话目录后缀：{父会话}.sub/ */
    public static final String SUB_DIR_SUFFIX = ".sub";
    /** subSessionId 白名单（同时用于文件名与 API 路径参数，防目录穿越） */
    private static final java.util.regex.Pattern SUB_SESSION_ID_PATTERN =
            java.util.regex.Pattern.compile("[A-Za-z0-9_-]{1,64}");

    /** 项目会话目录（与主会话同一目录，按项目隔离） */
    private final Path sessionsDir;

    public SubAgentSessionStore(Path sessionsDir) {
        this.sessionsDir = sessionsDir;
    }

    // ---- 路径 ----

    private static String sanitize(String name) {
        return name.replaceAll("[^\\p{L}\\p{N}_\\-\\[\\]]", "_");
    }

    /** 子代理会话目录：{sessionsDir}/{sanitize(父会话名)}.sub/ */
    public static Path subDir(Path sessionsDir, String parentSessionName) {
        return sessionsDir.resolve(sanitize(parentSessionName) + SUB_DIR_SUFFIX);
    }

    /** 子代理会话文件路径 */
    public static Path subSessionFile(Path sessionsDir, String parentSessionName, String subSessionId) {
        return subDir(sessionsDir, parentSessionName).resolve(subSessionId + ".jsonl");
    }

    /** subSessionId 合法性校验（文件名字符白名单，防目录穿越） */
    public static boolean isValidSubSessionId(String subSessionId) {
        return subSessionId != null && SUB_SESSION_ID_PATTERN.matcher(subSessionId).matches();
    }

    // ---- 写入 ----

    /**
     * 记录一条子代理事件（追加一行并立即 flush，然后关闭文件）。
     * 事件为段级/事件级（reasoning 完整段、tool call/result、content 完整段），
     * 频率低，打开-追加-关闭的开销可忽略；同时天然规避并发子代理的文件竞争。
     */
    public void record(String parentSessionName, String subSessionId, String type, Map<String, Object> payload) {
        if (!isValidSubSessionId(subSessionId)) {
            log.warn("[sub-store] 非法 subSessionId 忽略写入: {}", subSessionId);
            return;
        }
        Path file = subSessionFile(sessionsDir, parentSessionName, subSessionId);
        try {
            Files.createDirectories(file.getParent());
            ONode node = ONode.ofJson("{}");
            node.set("type", type);
            if (payload != null) {
                for (Map.Entry<String, Object> e : payload.entrySet()) {
                    node.set(e.getKey(), e.getValue());
                }
            }
            try (BufferedWriter w = Files.newBufferedWriter(file, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                w.write(node.toJson());
                w.newLine();
                w.flush();
            }
        } catch (IOException e) {
            log.warn("[sub-store] 记录子代理事件失败 {}({}): {}", subSessionId, type, e.getMessage());
        }
    }

    // ---- 查询 ----

    /**
     * 列出某主会话下的全部子代理会话（按开始时间倒序）。
     * 首行 sub_start 提供元数据，末行 sub_end 提供状态；无 sub_end 视为运行中/异常中断。
     */
    public List<SubSessionInfo> list(String parentSessionName) {
        List<SubSessionInfo> result = new ArrayList<>();
        Path dir = subDir(sessionsDir, parentSessionName);
        if (!Files.isDirectory(dir)) return result;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir, "*.jsonl")) {
            for (Path p : ds) {
                String subSessionId = p.getFileName().toString().replace(".jsonl", "");
                if (!isValidSubSessionId(subSessionId)) continue;
                try {
                    result.add(readInfo(p, subSessionId));
                } catch (Exception e) {
                    log.warn("[sub-store] 读取子代理会话失败 {}: {}", p.getFileName(), e.getMessage());
                }
            }
        } catch (IOException e) {
            log.warn("[sub-store] 列出子代理会话失败: {}", e.getMessage());
        }
        result.sort((a, b) -> Long.compare(b.startedAt(), a.startedAt()));
        return result;
    }

    /** 读取单个子代理会话文件的首尾行元数据与状态。 */
    private SubSessionInfo readInfo(Path file, String subSessionId) throws IOException {
        String firstLine = null;
        String lastLine = null;
        int eventCount = 0;
        try (BufferedReader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("//")) continue;
                if (firstLine == null) firstLine = line;
                lastLine = line;
                eventCount++;
            }
        }
        ONode first = firstLine == null ? null : safeParse(firstLine);
        ONode last = lastLine == null ? null : safeParse(lastLine);
        long startedAt = first != null ? first.get("startedAt").getLong() : 0L;
        String status = "running";
        long endedAt = 0L;
        if (last != null && "sub_end".equals(last.get("type").getString())) {
            status = last.get("status").getString();
            if (status == null) status = "completed";
            endedAt = last.get("endedAt").getLong();
        }
        BasicFileAttributes attr = Files.readAttributes(file, BasicFileAttributes.class);
        return new SubSessionInfo(subSessionId,
                first != null ? first.get("task").getString() : null,
                first != null ? first.get("name").getString() : null,
                first != null ? first.get("title").getString() : null,
                first != null ? first.get("profile").getString() : null,
                status, startedAt, endedAt, eventCount, attr.lastModifiedTime().toMillis());
    }

    /** 读取某子代理会话的全部事件（按发生顺序）。 */
    public List<Map<String, Object>> events(String parentSessionName, String subSessionId) {
        if (!isValidSubSessionId(subSessionId)) return List.of();
        Path file = subSessionFile(sessionsDir, parentSessionName, subSessionId);
        if (!Files.exists(file)) return List.of();
        List<Map<String, Object>> events = new ArrayList<>();
        try (BufferedReader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("//")) continue;
                ONode node = safeParse(line);
                if (node == null) continue;
                Map<String, Object> map = ONodeUtil.toMap(node);
                if (map != null) events.add(map);
            }
        } catch (IOException e) {
            log.warn("[sub-store] 读取子代理会话事件失败 {}: {}", subSessionId, e.getMessage());
        }
        return events;
    }

    private static ONode safeParse(String line) {
        try {
            return ONode.ofJson(line);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 删除单个子代理会话（文件 + 空目录清理）。
     * 调用方应确保会话不在运行中（运行中的记录器会重建文件）。
     *
     * @return 是否删除了文件
     */
    public boolean delete(String parentSessionName, String subSessionId) {
        if (!isValidSubSessionId(subSessionId)) return false;
        Path file = subSessionFile(sessionsDir, parentSessionName, subSessionId);
        try {
            boolean deleted = Files.deleteIfExists(file);
            if (deleted) {
                Path dir = file.getParent();
                try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
                    if (!ds.iterator().hasNext()) {
                        Files.deleteIfExists(dir);
                    }
                } catch (IOException ignored) {
                    // 目录清理失败不影响结果
                }
            }
            return deleted;
        } catch (IOException e) {
            log.warn("[sub-store] 删除子代理会话失败 {}: {}", subSessionId, e.getMessage());
            return false;
        }
    }

    // ---- 级联删除 ----

    /** 删除某主会话下的全部子代理会话（目录整体删除）。 */
    public static void deleteParent(Path sessionsDir, String parentSessionName) {
        Path dir = subDir(sessionsDir, parentSessionName);
        if (!Files.isDirectory(dir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) Files.deleteIfExists(p);
        } catch (IOException e) {
            log.warn("[sub-store] 清理子代理会话文件失败 {}: {}", dir, e.getMessage());
        }
        try {
            Files.deleteIfExists(dir);
        } catch (IOException e) {
            log.warn("[sub-store] 清理子代理会话目录失败 {}: {}", dir, e.getMessage());
        }
    }

    /** 清空所有主会话的子代理会话目录。 */
    public static void deleteAll(Path sessionsDir) {
        if (!Files.isDirectory(sessionsDir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(sessionsDir)) {
            for (Path p : ds) {
                if (Files.isDirectory(p) && p.getFileName().toString().endsWith(SUB_DIR_SUFFIX)) {
                    deleteParent(sessionsDir, p.getFileName().toString()
                            .substring(0, p.getFileName().toString().length() - SUB_DIR_SUFFIX.length()));
                }
            }
        } catch (IOException e) {
            log.warn("[sub-store] 清空子代理会话失败: {}", e.getMessage());
        }
    }

    /**
     * 子代理会话摘要信息。
     *
     * @param subSessionId 子代理会话唯一标识（文件标识，跨重启稳定）
     * @param task         会话名称（name + 任务首句；旧数据为纯任务描述）
     * @param name         子代理名字（人名/二次元名字等，旧数据可能为 null）
     * @param title        会话标题（任务首句，旧数据可能为 null）
     * @param profile      子代理角色
     * @param status       completed / aborted / error / running
     * @param startedAt    开始时间戳
     * @param endedAt      结束时间戳（运行中为 0）
     * @param eventCount   已落盘事件数
     * @param mtime        文件最后修改时间
     */
    public record SubSessionInfo(String subSessionId, String task, String name, String title, String profile,
                                 String status, long startedAt, long endedAt,
                                 int eventCount, long mtime) {
    }
}

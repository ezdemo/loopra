package site.sorghum.loopra.tool.solon.common;

import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.talents.cli.TerminalSessionManager;
import org.noear.solon.ai.talents.cli.TerminalTalent;
import org.noear.solon.ai.talents.mount.MountManager;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.ToolContext;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
  * 带被动写入/编辑变更追踪的 TerminalTalent。底层工具行为不变。
 */
public class SessionTerminalTalent extends TerminalTalent {
    private static final long MAX_TRACKED_BYTES = 512 * 1024;
    /** 单个后台会话累积输出日志的字符上限，超出时保留尾部。 */
    private static final int MAX_LOG_CHARS = 512 * 1024;
    /** 已结束会话在镜像中的保留时长 —— 供前端短暂展示“已结束”状态，与底层 10 分钟 TTL 无关。 */
    private static final long COMPLETED_VISIBLE_TTL_MS = 60_000;

    private final Path workspace;
    private final MountManager mountManager;

    /** bash_start/bash_wait/bash_stdin/bash_stop 后台会话镜像（sessionId → 会话信息）。 */
    private final ConcurrentMap<String, BashSessionInfo> bashSessions = new ConcurrentHashMap<>();

    /**
     * 服务端轮询提前读走、还没交给 agent 的工具返回文本（sessionId → 待交付文本）。
     * 底层命令会话只有一个读取位置（{@code CommandSession.nextOutputOffset}），
     * 我们读走了 agent 就会少看一段，所以必须原样还给它。
     */
    private final ConcurrentMap<String, StringBuilder> pendingToolResults = new ConcurrentHashMap<>();
    /** 单个会话待交付文本的上限，与镜像日志同量级。 */
    private static final int MAX_PENDING_CHARS = 512 * 1024;

    public SessionTerminalTalent(MountManager mountManager, String workspace) {
        super(mountManager);
        this.mountManager = mountManager;
        this.workspace = Path.of(workspace).toAbsolutePath().normalize();
        applyWindowsOutputCharsetFix();
    }

    /**
     * Windows 下命令输出的编码并不统一：git/node 等现代工具输出 UTF-8 字节（文件内容原样透传），
     * 而 cmd 内置命令（echo/type 等）按活动 OEM 代码页输出 GBK/936 字节。固定用任一编码解码
     * 都会导致另一半场景乱码，因此对两条执行路径（bashSessionManager 与 executor）统一注入
     * {@link AutoCharset}：UTF-8 严格解码优先，失败回退到活动代码页。
     * 非 Windows 或失败时保持默认行为。
     */
    private void applyWindowsOutputCharsetFix() {
        if (!isWindowsOs()) return;
        String codePage = queryWindowsCodePage();
        if (codePage == null || codePage.isEmpty()) return;
        final Charset charset;
        try {
            charset = Charset.forName("CP" + codePage);
        } catch (Exception ignored) {
            return; // 未知代码页（如 65001 即 UTF-8），保持默认
        }
        Charset auto = new AutoCharset(charset);
        try {
            executor.setOutputCharset(auto);
        } catch (Exception ignored) {
            // 保持默认 UTF-8 行为，不影响功能
        }
        try {
            Field field = TerminalTalent.class.getDeclaredField("bashSessionManager");
            field.setAccessible(true);
            field.set(this, new TerminalSessionManager(auto));
        } catch (Exception e) {
            // 反射失败时保持默认 UTF-8 行为，不影响功能
        }
    }

    private static boolean isWindowsOs() {
        return System.getProperty("os.name").toLowerCase().contains("win");
    }

    /** 通过 cmd 内置 chcp 查询活动代码页（如 "936"），失败返回 null。 */
    private static String queryWindowsCodePage() {
        try {
            Process process = new ProcessBuilder("cmd", "/c", "chcp")
                    .redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.US_ASCII);
            Matcher matcher = Pattern.compile("(\\d{3,5})").matcher(output);
            return matcher.find() ? matcher.group(1) : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    @Override
    @ToolMapping(name = TOOL_WRITE, description = "创建新文件或覆盖现有文件。")
    public String write(@Param(value = "file_path", description = "文件相对路径（如 'src/demo.md'）。'.' 表示当前根目录。") String filePath,
                        @Param(value = PARAM_CONTENT, description = "完整文本内容。") String content,
                        String __cwd) throws IOException {
        return track(filePath, __cwd, () -> super.write(filePath, content, __cwd));
    }

    @Override
    @ToolMapping(name = TOOL_EDIT, description = "对文件进行精准文本替换。支持单次调用执行一处或多处编辑。具有原子性：所有编辑成功才会写入，否则全部回滚。")
    public String edit(@Param(value = "file_path", description = "文件相对路径（如 'src/demo.md'）。'.' 表示当前根目录。") String filePath,
                       @Param(value = PARAM_EDITS, description = "编辑操作列表") List<EditOp> edits,
                       String __cwd) throws IOException {
        return track(filePath, __cwd, () -> super.edit(filePath, edits, __cwd));
    }

    /**
     * 注释相关能力 全套用bash_start
     */
    @Override
    @ToolMapping(
            name = "bash",
            description = "在终端执行非交互式 Shell 指令。支持多行命令与逻辑路径（如 `cd @pool1/bin/tool/`）。"
    )
    public String bash(@Param(value = "command", description = "要执行的指令。") String command,
                       @Param(name = "timeout", required = false, defaultValue = "120000", description = "可选超时时间，单位为毫秒") Integer timeout,
                       @Param(name = "max_output_chars", required = false, defaultValue = "64000", description = "本次最多返回多少字符输出") Integer maxOutputChars,
                       String __cwd) {
        int timeoutMs = timeout == null || timeout < 0 ? 120_000 : timeout;
        int outputLimit = maxOutputChars == null || maxOutputChars <= 0 ? 64_000 : maxOutputChars;
        // 以 bash_start 模拟同步执行：yield 与 hard_timeout 同为 timeoutMs。
        // 命令在 timeoutMs 内结束 → completed 快照，正常返回输出；
        // 超过 timeoutMs 未结束 → bashStart 返回 running 会话（此时尚未终止），
        // 与新版 bash 的“同步阻塞 + 硬超时即杀”语义对齐：主动终止并提示超时，
        // 避免返回不完整的中间输出让模型误判执行完毕。
        final String result;
        try {
            result = super.bashStart(command, null, timeoutMs, outputLimit, timeoutMs, __cwd);
        } catch (IOException e) {
            return "系统失败: " + e.getMessage();
        }
        String sessionId = commandSessionId(result);
        AgentLoopController controller = ToolContext.getCurrentController();
        if (controller != null && sessionId != null && isCommandRunning(result)) {
            controller.registerAbortResource(sessionId,
                    () -> bashSessionManager.terminate(sessionId, "用户停止生成", 64_000));
        }
        if (sessionId != null && isCommandRunning(result)) {
            // 已运行满 timeoutMs 未结束：终止会话并给出超时提示（同步语义）
            try {
                bashSessionManager.terminate(sessionId, "执行超时", outputLimit);
            } catch (Exception ignored) {
                // 底层硬超时可能已先终止会话
            }
            if (controller != null) controller.clearAbortResource(sessionId);
            return "执行超时：运行时间超过 " + timeoutMs + " 毫秒。";
        }
        if (result != null && result.contains("hard_timeout: true")) {
            return "执行超时：运行时间超过 " + timeoutMs + " 毫秒。";
        }
        return commandOutput(result);
    }

    @Override
    @ToolMapping(name = "bash_start", description = "启动 shell 命令会话。命令超过 yield-time_ms 仍未结束时不会失败，而是返回 session_id，后续可用 bash_wait 继续等待、bash_stdin 输入或 bash_stop 终止。")
    public String bashStart(@Param(value = "command", description = "要执行的 shell 命令。") String command,
                            @Param(value = "workdir", required = false, description = "工作目录。默认使用当前项目。") String workdir,
                            @Param(value = "yield_time_ms", required = false, defaultValue = "1000") Integer yieldTimeMs,
                            @Param(value = "max_output_chars", required = false, defaultValue = "64000") Integer maxOutputChars,
                            @Param(value = "hard_timeout_ms", required = false, defaultValue = "120000") Integer hardTimeoutMs,
                            String __cwd) throws IOException {
        String result = super.bashStart(command, workdir, yieldTimeMs, maxOutputChars, hardTimeoutMs, __cwd);
        String sessionId = commandSessionId(result);
        if (sessionId != null && isCommandRunning(result)) {
            BashSessionInfo info = new BashSessionInfo(
                    sessionId, workspace.toString(), command, commandWorkdir(workdir, __cwd));
            info.appendOutput(extractCommandOutput(result));
            bashSessions.put(sessionId, info);
        }
        AgentLoopController controller = ToolContext.getCurrentController();
        if (controller != null && sessionId != null && isCommandRunning(result)) {
            controller.registerAbortResource(sessionId,
                    () -> bashSessionManager.terminate(sessionId, "用户停止生成", 64_000));
        }
        return result;
    }

    @Override
    @ToolMapping(name = "bash_wait", description = "继续等待命令会话，返回新增输出或最终状态；可通过 chars 写入 stdin。")
    public String bashWait(@Param(value = "session_id") String sessionId,
                           @Param(value = "chars", required = false, description = "可选。要写入 stdin 的文本；不传时仅等待。") String chars,
                           @Param(value = "yield_time_ms", required = false, defaultValue = "1000") Integer yieldTimeMs,
                           @Param(value = "max_output_chars", required = false, defaultValue = "64000") Integer maxOutputChars) throws IOException {
        // 面板轮询可能已经替它读过并把文本排在这里：先还给 agent，保证一条输出都不少
        String queued = takeQueuedResult(sessionId);
        if (queued != null && (chars == null || chars.isEmpty())) return queued;
        String result = super.bashWait(sessionId, chars, yieldTimeMs, maxOutputChars);
        appendBashOutput(sessionId, result);
        markBashSessionCompleted(sessionId, result);
        clearCompletedCommand(sessionId, result);
        return queued == null ? result : queued + "\n" + result;
    }

    /** 兼容现有 Java 调用方的只等待入口。 */
    public String bashWait(String sessionId, Integer yieldTimeMs, Integer maxOutputChars) throws IOException {
        return bashWait(sessionId, null, yieldTimeMs, maxOutputChars);
    }

    @ToolMapping(name = "bash_stdin", description = "向仍在运行的命令会话写入 stdin，然后等待新增输出或进程结束。")
    public String bashStdin(@Param(value = "session_id") String sessionId,
                            @Param(value = "chars") String chars,
                            @Param(value = "yield_time_ms", required = false, defaultValue = "1000") Integer yieldTimeMs,
                            @Param(value = "max_output_chars", required = false, defaultValue = "64000") Integer maxOutputChars) throws IOException {
        return bashWait(sessionId, chars, yieldTimeMs, maxOutputChars);
    }

    @Override
    @ToolMapping(name = "bash_stop", description = "终止仍在运行的命令会话及其子进程树。")
    public String bashStop(@Param(value = "session_id") String sessionId,
                           @Param(value = "reason", required = false) String reason,
                           @Param(value = "max_output_chars", required = false, defaultValue = "64000") Integer maxOutputChars) {
        String queued = takeQueuedResult(sessionId);
        String result = null;
        try {
            result = super.bashStop(sessionId, reason, maxOutputChars);
            return queued == null ? result : queued + "\n" + result;
        } finally {
            if (sessionId != null) {
                BashSessionInfo info = bashSessions.get(sessionId);
                if (info != null) info.appendOutput(extractCommandOutput(result));
                bashSessions.remove(sessionId);
                pendingToolResults.remove(sessionId);
            }
            AgentLoopController controller = ToolContext.getCurrentController();
            if (controller != null) controller.clearAbortResource(sessionId);
        }
    }

    /**
     * 面板轮询时顺手把会话的最新输出读回来（yield=0，不阻塞调用方）：
     * <ul>
     *   <li>追加到镜像 —— 否则没人调用 bash_wait 时，面板永远停在启动那一屏；</li>
     *   <li>把读到的文本排队还给 agent —— 底层读取位置是共用的，不能白拿；</li>
     *   <li>借返回文本里的状态修正镜像 —— 否则进程自己退出后，面板会一直显示 running。</li>
     * </ul>
     * 会话在底层已消失（例如被 bash_stop 收走）时按已完成处理，别让它继续挂在列表里。
     */
    private void drainBashSession(BashSessionInfo info) {
        if (info == null || !info.isRunning()) return;
        String sessionId = info.getSessionId();
        try {
            String result = super.bashWait(sessionId, null, 0, 64_000);
            info.appendOutput(extractCommandOutput(result));
            queueForAgent(sessionId, result);
            markBashSessionCompleted(sessionId, result);
            if (!info.isRunning()) clearCompletedCommand(sessionId, result);
        } catch (Exception error) {
            info.markCompleted();
        }
    }

    /**
     * 只把「有新增输出」或「状态已结束」的返回文本排队，避免轮询把无意义的占位块堆给 agent。
     */
    private void queueForAgent(String sessionId, String result) {
        if (sessionId == null || result == null) return;
        if (extractCommandOutput(result).isEmpty() && isCommandRunning(result)) return;
        StringBuilder buffer = pendingToolResults.computeIfAbsent(sessionId, key -> new StringBuilder());
        synchronized (buffer) {
            buffer.append(result);
            if (buffer.length() > MAX_PENDING_CHARS) buffer.delete(0, buffer.length() - MAX_PENDING_CHARS);
        }
    }

    /** 取走该会话待交付给 agent 的文本；没有待交付内容时返回 null。 */
    private String takeQueuedResult(String sessionId) {
        if (sessionId == null) return null;
        StringBuilder buffer = pendingToolResults.remove(sessionId);
        if (buffer == null) return null;
        synchronized (buffer) {
            return buffer.length() == 0 ? null : buffer.toString();
        }
    }

    /**
     * 将 bash_start/wait/stdin/stop 返回文本中的增量输出追加到会话日志镜像。
     */
    private void appendBashOutput(String sessionId, String result) {
        if (sessionId == null) return;
        BashSessionInfo info = bashSessions.get(sessionId);
        if (info != null) info.appendOutput(extractCommandOutput(result));
    }

    /**
     * 从工具返回文本中提取 Output: 段（增量输出），无输出时返回空串。
     */
    private static String extractCommandOutput(String result) {
        if (result == null) return "";
        String marker = "\nOutput:\n";
        int outputStart = result.indexOf(marker);
        if (outputStart < 0) return "";
        String output = result.substring(outputStart + marker.length());
        return "(no new output)".equals(output.trim()) ? "" : output;
    }

    private static String commandOutput(String result) {
        if (result == null) return "";
        String marker = "\nOutput:\n";
        int outputStart = result.indexOf(marker);
        return outputStart >= 0 ? result.substring(outputStart + marker.length()).trim() : result;
    }

    private static String commandSessionId(String result) {
        if (result == null) return null;
        for (String line : result.split("\\R")) {
            if (line.startsWith("session_id: ")) return line.substring("session_id: ".length()).trim();
        }
        return null;
    }

    /** 4.1.1 的命令返回文本不再包含 workdir，按已通过框架校验的调用参数恢复面板元数据。 */
    private String commandWorkdir(String workdir, String cwd) {
        Path base = cwd == null ? workspace : Path.of(cwd).toAbsolutePath().normalize();
        if (workdir == null || workdir.isEmpty() || ".".equals(workdir)) return base.toString();
        String path = workdir.startsWith("./") ? workdir.substring(2) : workdir;
        if (path.startsWith("@")) {
            return mountManager.resolveResource(path).getLocalPath().orElseThrow().toString();
        }
        if (path.equals("~") || path.startsWith("~/") || path.startsWith("~\\")) {
            path = System.getProperty("user.home") + path.substring(1);
        }
        return base.resolve(path).normalize().toString();
    }

    /**
     * bash_wait / bash_stdin 检测到会话已结束（非 running）时，将镜像标记为 completed。
     */
    private void markBashSessionCompleted(String sessionId, String result) {
        if (sessionId == null) return;
        BashSessionInfo info = bashSessions.get(sessionId);
        if (info != null && !isCommandRunning(result)) {
            info.markCompleted();
        }
    }

    /**
     * 返回本项目的会话镜像快照（先读一次实时输出，再清理过期 completed 项）。
     */
    public List<BashSessionInfo> snapshotBashSessions() {
        long now = System.currentTimeMillis();
        // 前端每 3 秒拉一次列表，顺便把运行中的会话读回来（非阻塞）：这样"没人调用
        // bash_wait"时面板也能看到最新输出，并拿到进程真实的存活状态。
        bashSessions.values().forEach(this::drainBashSession);
        bashSessions.entrySet().removeIf(entry -> {
            if (!entry.getValue().isExpired(now)) return false;
            pendingToolResults.remove(entry.getKey());
            return true;
        });
        return new ArrayList<>(bashSessions.values());
    }

    /**
     * 跨项目聚合所有 bash 后台会话镜像，按启动时间倒序（新 → 旧）。
     */
    public static List<BashSessionInfo> aggregateBashSessions() {
        List<BashSessionInfo> all = new ArrayList<>();
        for (LoopraSkillProvider provider : LoopraSkillProvider.cliSkillProviderMap.values()) {
            SessionTerminalTalent talent = provider.terminalTalent;
            if (talent != null) {
                all.addAll(talent.snapshotBashSessions());
            }
        }
        all.sort(Comparator.comparingLong(BashSessionInfo::getStartedAt).reversed());
        return all;
    }

    /**
     * 终止本实例的指定 bash 会话（前端“手动关闭”入口的实例能力）。
     *
     * @return 终止后的状态日志文本（含 session_id/状态/原因/最后输出）；未找到会话返回 null
     */
    public String terminateSession(String sessionId, String reason) {
        if (sessionId == null || sessionId.isBlank()) return null;
        if (!bashSessions.containsKey(sessionId)) return null;
        try {
            TerminalSessionManager.CommandSnapshot snapshot = bashSessionManager.terminate(sessionId,
                    reason == null ? "用户手动关闭" : reason, 64_000);
            return formatTerminateMessage(snapshot);
        } catch (Exception e) {
            // 底层会话可能已结束（镜像滞后），仍清理镜像
            return null;
        } finally {
            bashSessions.remove(sessionId);
        }
    }

    /**
     * 手动终止指定 bash 后台会话（前端“手动关闭”入口）。
     *
     * @param sessionId   命令会话 ID
     * @param workspace   项目绝对路径；为空时在所有项目中查找
     * @param reason      终止原因（仅日志诊断）
     * @return 终止后的状态日志文本；未找到会话返回 null
     */
    public static String terminateBashSession(String sessionId, String workspace, String reason) {
        if (sessionId == null || sessionId.isBlank()) return null;
        for (LoopraSkillProvider provider : LoopraSkillProvider.cliSkillProviderMap.values()) {
            SessionTerminalTalent talent = provider.terminalTalent;
            if (talent == null) continue;
            if (workspace != null && !workspace.isEmpty()
                    && !talent.workspace.equals(Path.of(workspace).toAbsolutePath().normalize())) {
                continue;
            }
            String message = talent.terminateSession(sessionId, reason);
            if (message != null) return message;
        }
        return null;
    }

    /**
     * 按 sessionId（可限定项目）查找后台会话镜像，供前端查询累积输出日志。
     *
     * @param sessionId 命令会话 ID
     * @param workspace 项目绝对路径；为空时在所有项目中查找
     * @return 会话镜像；未找到返回 null
     */
    public static BashSessionInfo findBashSession(String sessionId, String workspace) {
        if (sessionId == null || sessionId.isBlank()) return null;
        for (LoopraSkillProvider provider : LoopraSkillProvider.cliSkillProviderMap.values()) {
            SessionTerminalTalent talent = provider.terminalTalent;
            if (talent == null) continue;
            if (workspace != null && !workspace.isEmpty()
                    && !talent.workspace.equals(Path.of(workspace).toAbsolutePath().normalize())) {
                continue;
            }
            BashSessionInfo info = talent.bashSessions.get(sessionId);
            if (info != null) {
                // 「查看日志」是直接按 sessionId 取的，这里也先读一次，免得刚打开看到的还是旧内容
                talent.drainBashSession(info);
                return info;
            }
        }
        return null;
    }

    /**
     * 将终止快照格式化为提示日志文本（供前端展示）。
     */
    private static String formatTerminateMessage(TerminalSessionManager.CommandSnapshot snapshot) {
        if (snapshot == null) return null;
        StringBuilder sb = new StringBuilder();
        sb.append("✅ 已关闭后台进程\n");
        sb.append("session_id: ").append(snapshot.sessionId()).append('\n');
        sb.append("status: ").append(snapshot.running() ? "running" : "completed").append('\n');
        if (snapshot.terminated()) {
            sb.append("terminated: true\n");
        }
        if (snapshot.terminateReason() != null) {
            sb.append("terminate_reason: ").append(snapshot.terminateReason()).append('\n');
        }
        if (snapshot.exitCode() != null) {
            sb.append("exit_code: ").append(snapshot.exitCode()).append('\n');
        }
        String output = snapshot.output();
        if (output != null && !output.isBlank()) {
            String tail = output.length() > 300 ? output.substring(output.length() - 300) : output;
            sb.append("最后输出:\n").append(tail);
        }
        return sb.toString();
    }

    /**
     * bash 后台会话镜像条目。status 为 running / completed；completed 保留 {@link #COMPLETED_VISIBLE_TTL_MS} 后清理。
     */
    public static final class BashSessionInfo {
        private final String sessionId;
        private final String workspace;
        private final String command;
        private final String workdir;
        private final long startedAt;
        private volatile String status;
        private volatile long completedAt;
        /** 累积输出日志（bash_start 初始输出 + bash_wait/stdin 增量输出），超出上限时保留尾部。 */
        private final StringBuilder outputLog = new StringBuilder();

        BashSessionInfo(String sessionId, String workspace, String command, String workdir) {
            this.sessionId = sessionId;
            this.workspace = workspace;
            this.command = command;
            this.workdir = workdir;
            this.startedAt = System.currentTimeMillis();
            this.status = "running";
        }

        public String getSessionId() {
            return sessionId;
        }

        public String getWorkspace() {
            return workspace;
        }

        public String getCommand() {
            return command;
        }

        public String getWorkdir() {
            return workdir;
        }

        public long getStartedAt() {
            return startedAt;
        }

        public String getStatus() {
            return status;
        }

        public long getCompletedAt() {
            return completedAt;
        }

        public boolean isRunning() {
            return "running".equals(status);
        }

        void markCompleted() {
            this.status = "completed";
            this.completedAt = System.currentTimeMillis();
        }

        void appendOutput(String chunk) {
            if (chunk == null || chunk.isEmpty()) return;
            synchronized (outputLog) {
                outputLog.append(chunk);
                if (outputLog.length() > MAX_LOG_CHARS) {
                    outputLog.delete(0, outputLog.length() - MAX_LOG_CHARS);
                }
            }
        }

        public String getOutput() {
            synchronized (outputLog) {
                return outputLog.toString();
            }
        }

        boolean isExpired(long now) {
            return completedAt > 0 && now - completedAt > COMPLETED_VISIBLE_TTL_MS;
        }
    }

    private static boolean isCommandRunning(String result) {
        return result != null && result.contains("status: running");
    }

    private static void clearCompletedCommand(String sessionId, String result) {
        AgentLoopController controller = ToolContext.getCurrentController();
        if (controller != null && !isCommandRunning(result)) {
            controller.clearAbortResource(sessionId);
        }
    }

    private String track(String filePath, String cwd, IoCall action) throws IOException {
        Path target = resolveTrackedPath(filePath, cwd);
        Snapshot before = readText(target);
        String result = action.call();
        Snapshot after = readText(target);
        if (before != null && after != null) {
            SessionFileChangeTracker.record(displayPath(filePath, target), before.content(), after.content(), !before.exists());
        }
        return result;
    }

    private Path resolveTrackedPath(String filePath, String cwd) {
        if (filePath == null || filePath.startsWith("@")) return null;
        try {
            Path path = Path.of(filePath);
            if (path.isAbsolute()) return path.normalize();
            Path root = cwd == null || cwd.isBlank() ? workspace : Path.of(cwd);
            return root.resolve(path).normalize();
        } catch (Exception ignored) {
            return null;
        }
    }

    private Snapshot readText(Path path) {
        try {
            if (path == null) return null;
            if (!Files.exists(path)) return new Snapshot(false, "");
            if (!Files.isRegularFile(path) || Files.size(path) > MAX_TRACKED_BYTES) return null;
            return new Snapshot(true, Files.readString(path, StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            return null;
        }
    }

    private String displayPath(String filePath, Path target) {
        try {
            if (target != null && target.startsWith(workspace)) {
                return workspace.relativize(target).toString().replace('\\', '/');
            }
        } catch (Exception ignored) {
             // 回退到工具参数。
        }
        return filePath == null ? "未知文件" : filePath.replace('\\', '/');
    }

    @FunctionalInterface
    private interface IoCall {
        String call() throws IOException;
    }

    private record Snapshot(boolean exists, String content) {
    }
}

package site.sorghum.loopra.tool.solon.common;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.noear.solon.ai.talents.cli.TerminalSessionManager;
import org.noear.solon.ai.talents.cli.TerminalTalent;
import org.noear.solon.ai.talents.mount.MountManager;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * SessionTerminalTalent bash 后台会话镜像测试 —— 覆盖 bash_start 记录 / bash_wait 完成标记 /
 * bash_stop 移除 / completed 过期清理 / 跨项目聚合入口。
 * <p>
 * 通过真实系统 ping 模拟长会话（持续运行）与短会话（自然结束）。
 * </p>
 * <p>
 * 项目不用 @TempDir：bash 会话进程以工作目录为 cwd，Windows 下进程存活期间目录被占用，
 * 测试结束 @TempDir 清理会失败；改为手动创建、不强制删除（与 LoopraAgentInjectionTest 同策略）。
 * </p>
 *
 * @author Sorghum
 */
class SessionTerminalTalentBashSessionTest {

    private static final String RUNNING_PING = isWindows() ? "ping 127.0.0.1 -t" : "ping 127.0.0.1";
    private static final String FINITE_PING = isWindows() ? "ping 127.0.0.1 -n 2" : "ping -c 2 127.0.0.1";
    /**
     * 先沉默 1 秒、打一行、再长时间沉默：这行输出必须落在 bash_start 的 yield 窗口之后，
     * 才真的属于"只有面板轮询才可能读走"的那一段（否则 bash_start 自己就消费掉了）。
     */
    private static final String MARK = "LOOPRA-PANEL-MARK";
    /**
     * 用 ping 而不是 timeout 制造延迟：test/CI 进程的 stdin 不是控制台，
     * Windows 的 timeout.exe 会报 “Input redirection is not supported” 立刻退出，
     * 命令在 bash_start 的 yield 窗口前就结束了，面板根本没机会看到输出。
     */
    private static final String QUIET_MARK_COMMAND = isWindows()
            ? "ping -n 2 127.0.0.1 > nul & echo " + MARK + " & ping -n 31 127.0.0.1 > nul"
            : "sleep 1; echo " + MARK + "; sleep 30";

    private static Path workspace;
    private static String previousWindowsShell;

    private SessionTerminalTalent talent;

    @BeforeAll
    static void createWorkspace() throws IOException {
        workspace = Files.createTempDirectory("loopra-bash-session-workspace");
        if (isWindows()) {
            // These fixtures use CMD syntax (&, > nul, &&). Shell auto-detection
            // depends on the IDE/CI launcher and may otherwise choose PowerShell.
            previousWindowsShell = System.getProperty("solon.ai.cli.shell");
            System.setProperty("solon.ai.cli.shell", "cmd");
        }
    }

    @AfterAll
    static void cleanupWorkspace() {
        try {
            Files.deleteIfExists(workspace);
        } catch (IOException ignored) {
            // 进程句柄占用时无法删除，容忍
        } finally {
            if (isWindows()) {
                if (previousWindowsShell == null) System.clearProperty("solon.ai.cli.shell");
                else System.setProperty("solon.ai.cli.shell", previousWindowsShell);
            }
        }
    }

    @BeforeEach
    void setUp() {
        talent = new SessionTerminalTalent(new MountManager(workspace.toString()), workspace.toString());
    }

    @AfterEach
    void tearDown() {
        // 清理所有遗留会话，避免测试残留系统进程
        for (SessionTerminalTalent.BashSessionInfo info : talent.snapshotBashSessions()) {
            try {
                talent.bashStop(info.getSessionId(), "测试清理", 4096);
            } catch (Exception ignored) {
                // 会话可能已结束，忽略
            }
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name").toLowerCase().contains("win");
    }

    @Test
    void bashWaitCanSendInputWithoutLosingPanelOutput() throws Exception {
        String command = isWindows()
                ? "powershell -NoProfile -NonInteractive -Command \"Start-Sleep -Milliseconds 500; [Console]::WriteLine('INPUT-READY'); [Console]::WriteLine([Console]::ReadLine())\""
                : "sleep 0.5; echo INPUT-READY; read line; printf '%s\\n' \"$line\"";
        String start = talent.bashStart(command, null, 100, 4096, 30_000, null);
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId);
        String output = "";
        for (int i = 0; i < 50 && !output.contains("INPUT-READY"); i++) {
            Thread.sleep(100);
            output = mirrorOutput(sessionId);
        }
        assertTrue(output.contains("INPUT-READY"), "panel must read the readiness marker before sending input");

        String result = talent.bashWait(sessionId, "LOOPRA-INPUT\n", 5_000, 4096);
        assertTrue(result.contains("INPUT-READY"), "panel output must still reach the agent");
        assertTrue(result.contains("LOOPRA-INPUT"), "queued output must not prevent stdin delivery");
        assertTrue(result.contains("status: completed"));
    }

    @Test
    void legacyBashStdinStillWritesToCommandSessions() throws Exception {
        String command = isWindows()
                ? "powershell -NoProfile -NonInteractive -Command \"[Console]::WriteLine([Console]::ReadLine())\""
                : "read line; printf '%s\\n' \"$line\"";
        String start = talent.bashStart(command, null, 100, 4096, 30_000, null);
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId);
        String result = talent.bashStdin(sessionId, "LEGACY-INPUT\n", 5_000, 4096);
        assertTrue(result.contains("LEGACY-INPUT"));
        assertTrue(result.contains("status: completed"));
    }

    @Test
    void commandWorkdirMetadataResolvesRelativeToTheCallingDirectory() throws Exception {
        Path cwd = Files.createDirectories(workspace.resolve("calling-directory"));
        Path target = Files.createDirectories(cwd.resolve("child"));
        String start = talent.bashStart(RUNNING_PING, "child", 100, 4096, 60_000, cwd.toString());
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId);
        assertEquals(target.toString(), talent.snapshotBashSessions().stream()
                .filter(info -> sessionId.equals(info.getSessionId())).findFirst().orElseThrow().getWorkdir());
    }

    @Test
    void bashStartRecordsRunningSession() throws Exception {
        String result = talent.bashStart(RUNNING_PING, null, 300, 4096, 60_000, null);

        assertTrue(result.contains("status: running"), "长命令应保持运行: " + result);
        String sessionId = extractSessionId(result);
        assertNotNull(sessionId, "运行中的命令应返回 session_id");

        List<SessionTerminalTalent.BashSessionInfo> sessions = talent.snapshotBashSessions();
        assertEquals(1, sessions.size());
        SessionTerminalTalent.BashSessionInfo info = sessions.get(0);
        assertEquals(sessionId, info.getSessionId());
        assertEquals(RUNNING_PING, info.getCommand());
        assertEquals(workspace.toAbsolutePath().normalize().toString(), info.getWorkdir());
        assertTrue(info.isRunning());
        assertTrue(info.getStartedAt() > 0);
    }

    @Test
    void bashWaitMarksCompleted() throws Exception {
        String start = talent.bashStart(FINITE_PING, null, 100, 4096, 60_000, null);
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId, "短命令启动瞬间也应处于运行窗口: " + start);
        assertTrue(talent.snapshotBashSessions().stream()
                .anyMatch(i -> sessionId.equals(i.getSessionId())), "bash_start 后镜像应含该会话");

        String waited = talent.bashWait(sessionId, 10_000, 4096);
        assertTrue(waited.contains("status: completed"), "短命令等待后应结束: " + waited);

        SessionTerminalTalent.BashSessionInfo info = talent.snapshotBashSessions().stream()
                .filter(i -> sessionId.equals(i.getSessionId())).findFirst().orElse(null);
        assertNotNull(info, "completed 会话在保留窗口内仍应可见");
        assertFalse(info.isRunning());
        assertEquals("completed", info.getStatus());
        assertTrue(info.getCompletedAt() > 0);
    }

  @Test
  void bashStopRemovesSession() throws Exception {
    String start = talent.bashStart(RUNNING_PING, null, 300, 4096, 60_000, null);
    String sessionId = extractSessionId(start);
    assertNotNull(sessionId);

    talent.bashStop(sessionId, "测试终止", 4096);

    assertTrue(talent.snapshotBashSessions().isEmpty(), "bash_stop 后镜像应移除该会话");
  }
    
  @Test
  void terminateSessionClosesProcessAndRemovesMirror() throws Exception {
    String start = talent.bashStart(RUNNING_PING, null, 300, 4096, 60_000, null);
    String sessionId = extractSessionId(start);
    assertNotNull(sessionId);
    assertFalse(talent.snapshotBashSessions().isEmpty());

    String message = talent.terminateSession(sessionId, "测试关闭");
    assertNotNull(message, "镜像中存在该会话时应返回终止状态日志");
    assertTrue(message.contains(sessionId), "日志应包含 session_id: " + message);
    assertTrue(message.contains("已关闭后台进程"), "日志应含关闭提示: " + message);
    assertTrue(talent.snapshotBashSessions().isEmpty(), "终止后镜像应移除");

    // 再次终止已不存在的会话 → null
    assertNull(talent.terminateSession(sessionId, "再次关闭"));
  }

  @Test
  void staticTerminateWithoutProvidersReturnsNull() {
    // 纯 JUnit 无 Solon 容器，cliSkillProviderMap 为空 → 静态入口可用且找不到会话
    assertNull(SessionTerminalTalent.terminateBashSession("cmd_unknown", null, "测试"));
  }

  @Test
  void bashOutputAccumulatesAcrossStartAndWait() throws Exception {
    String start = talent.bashStart("echo hello-1 && " + FINITE_PING, null, 300, 4096, 60_000, null);
    String sessionId = extractSessionId(start);
    assertNotNull(sessionId, "命令应返回 session_id: " + start);

    SessionTerminalTalent.BashSessionInfo info = talent.snapshotBashSessions().stream()
            .filter(i -> sessionId.equals(i.getSessionId())).findFirst().orElse(null);
    assertNotNull(info, "bash_start 后镜像应含该会话");
    // A running process may not emit its first bytes during bash_start's yield
    // window, especially on a cold CI worker. Poll until the output arrives.
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (!info.getOutput().contains("hello-1") && System.nanoTime() < deadline) {
      Thread.sleep(50);
      talent.snapshotBashSessions();
    }
    assertTrue(info.getOutput().contains("hello-1"), "命令输出应已累积: " + info.getOutput());

    String waited = talent.bashWait(sessionId, 10_000, 4096);
    assertTrue(waited.contains("status: completed"), "短命令等待后应结束: " + waited);
    assertFalse(info.getOutput().isEmpty(), "bash_wait 后日志应继续累积");
    assertEquals("completed", info.getStatus());
  }

  @Test
  void findBashSessionUnknownReturnsNull() {
    // 纯 JUnit 无 Solon 容器，cliSkillProviderMap 为空 → 静态入口可用且找不到会话
    // （命中分支依赖 Solon 容器注册 provider，由真实应用覆盖，与 terminateBashSession 同策略）
    assertNull(SessionTerminalTalent.findBashSession("cmd_unknown", null));
    assertNull(SessionTerminalTalent.findBashSession("cmd_unknown", workspace.toString()));
    assertNull(SessionTerminalTalent.findBashSession("", null));
  }

  @Test
  void windowsBashManagerUsesSystemCodePageCharset() throws Exception {
    assumeTrue(isWindows(), "仅 Windows 需要代码页修复");

    Field managerField = TerminalTalent.class.getDeclaredField("bashSessionManager");
    managerField.setAccessible(true);
    TerminalSessionManager manager = (TerminalSessionManager) managerField.get(talent);
    Field charsetField = TerminalSessionManager.class.getDeclaredField("outputCharset");
    charsetField.setAccessible(true);
    Charset charset = (Charset) charsetField.get(manager);

    assertNotEquals(StandardCharsets.UTF_8, charset, "Windows 下不应再用 UTF-8 解码子进程输出");
    // CI runner 的活动代码页可能是 437/1252 等非中文代码页，断言必须跟随实际代码页，
    // 而不是假定中文 Windows 的 CP936。
    String codePage = activeWindowsCodePage();
    Assumptions.assumeFalse("65001".equals(codePage), "活动代码页为 UTF-8，无需代码页兜底");
    String expected = Charset.forName("CP" + codePage).name();
    String name = charset.name();
    if (name.startsWith("x-auto-")) {
      // AutoCharset：UTF-8 优先、活动代码页兜底；验证兜底编码确实为活动代码页
      Field fallbackField = AutoCharset.class.getDeclaredField("fallback");
      fallbackField.setAccessible(true);
      Charset fallback = (Charset) fallbackField.get(charset);
      assertEquals(expected, fallback.name(),
          "AutoCharset 兜底应为活动代码页 " + codePage + "，实际: " + fallback.name());
    } else {
      assertEquals(expected, name, "应按活动代码页 " + codePage + " 解码，实际: " + name);
    }
  }

  /** 通过 cmd 内置 chcp 读取当前活动代码页（如 "936"）。 */
  private static String activeWindowsCodePage() throws Exception {
    Process process = new ProcessBuilder("cmd", "/c", "chcp").redirectErrorStream(true).start();
    String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.US_ASCII);
    assertTrue(process.waitFor(5, TimeUnit.SECONDS), "读取活动代码页超时: " + output);
    Matcher matcher = Pattern.compile("(\\d{3,5})").matcher(output);
    assertTrue(matcher.find(), "无法读取活动代码页: " + output);
    return matcher.group(1);
  }

  @Test
  void windowsChineseOutputNotGarbled() throws Exception {
    assumeTrue(isWindows(), "仅 Windows 验证编码修复");
    String result = talent.bashStart("echo 你好", null, 800, 4096, 60_000, null);
    assertNotNull(result, "bash_start 应正常返回");

    Field managerField = TerminalTalent.class.getDeclaredField("bashSessionManager");
    managerField.setAccessible(true);
    TerminalSessionManager manager = (TerminalSessionManager) managerField.get(talent);
    Field charsetField = TerminalSessionManager.class.getDeclaredField("outputCharset");
    charsetField.setAccessible(true);
    Charset charset = (Charset) charsetField.get(manager);

    if ("GBK".equals(charset.name()) || "CP936".equals(charset.name())) {
      assertTrue(result.contains("你好"), "中文系统下中文输出不应乱码: " + result);
    }
  }

    @Test
    void completedSessionsAreCleanedAfterTtl() throws Exception {
        SessionTerminalTalent.BashSessionInfo info =
                new SessionTerminalTalent.BashSessionInfo("cmd_test", workspace.toString(), "echo x", workspace.toString());
        info.markCompleted();

        assertFalse(info.isExpired(System.currentTimeMillis()), "刚完成不应过期");
        assertTrue(info.isExpired(System.currentTimeMillis() + 61_000), "超过 60s TTL 应过期");

        // 验证 snapshot 清理：把已完成 61s 的会话塞进镜像，快照时应被移除
        Field sessionsField = SessionTerminalTalent.class.getDeclaredField("bashSessions");
        sessionsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, SessionTerminalTalent.BashSessionInfo> sessions =
                (Map<String, SessionTerminalTalent.BashSessionInfo>) sessionsField.get(talent);

        Field completedAtField = SessionTerminalTalent.BashSessionInfo.class.getDeclaredField("completedAt");
        completedAtField.setAccessible(true);
        completedAtField.setLong(info, System.currentTimeMillis() - 61_000);

        sessions.put(info.getSessionId(), info);
        assertTrue(talent.snapshotBashSessions().isEmpty(), "过期 completed 会话应被清理");
    }

    @Test
    void aggregateWithoutProvidersReturnsEmpty() {
        // 纯 JUnit 环境无 Solon 容器，cliSkillProviderMap 应为空 → 聚合入口可用且返回空
        assertTrue(SessionTerminalTalent.aggregateBashSessions().isEmpty());
    }

    /**
     * 前端每 3 秒拉一次列表（snapshot），服务端顺手读一次会话输出。
     * 这里全程不调用 bashWait —— 模拟"AI 起了命令就走人"，面板也必须能看到输出。
     */
    @Test
    void panelPollDeliversOutputWithoutAnyBashWait() throws Exception {
        String start = talent.bashStart(QUIET_MARK_COMMAND, null, 300, 64_000, 60_000, null);
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId, "长命令应返回 session_id: " + start);

        String output = "";
        for (int i = 0; i < 40 && !output.contains(MARK); i++) {
            Thread.sleep(100);
            output = mirrorOutput(sessionId);
        }
        assertTrue(output.contains(MARK), "没人调用 bash_wait 时，面板也应该读到输出，而不是停在启动那一屏: " + output);
    }

    /**
     * 面板轮询是"抢先读"：底层命令会话只有一个读取位置，读走之后必须还给 agent。
     */
    @Test
    void panelPollDoesNotStealOutputFromAgent() throws Exception {
        String start = talent.bashStart(QUIET_MARK_COMMAND, null, 300, 64_000, 60_000, null);
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId);

        String output = "";
        for (int i = 0; i < 40 && !output.contains(MARK); i++) {
            Thread.sleep(100);
            output = mirrorOutput(sessionId);
        }
        assertTrue(output.contains(MARK), "面板轮询应已把输出读进镜像");

        String waited = talent.bashWait(sessionId, 0, 64_000);
        assertTrue(waited.contains(MARK), "面板读过之后，agent 的 bash_wait 不能什么都拿不到: " + waited);
    }

    /**
     * 命令自己退出、而没有任何人调用 bash_wait 时，面板状态也要跟着变，不能一直显示 running。
     */
    @Test
    void panelPollMarksCompletedWhenProcessExitsOnItsOwn() throws Exception {
        String start = talent.bashStart(FINITE_PING, null, 150, 4096, 60_000, null);
        String sessionId = extractSessionId(start);
        assertNotNull(sessionId);

        String status = "running";
        for (int i = 0; i < 100 && "running".equals(status); i++) {
            Thread.sleep(100);
            status = talent.snapshotBashSessions().stream()
                    .filter(info -> sessionId.equals(info.getSessionId()))
                    .map(SessionTerminalTalent.BashSessionInfo::getStatus)
                    .findFirst().orElse("completed");
        }
        assertEquals("completed", status, "进程自然退出后镜像应变为 completed，而不是一直 running");
    }

    private String mirrorOutput(String sessionId) {
        return talent.snapshotBashSessions().stream()
                .filter(info -> sessionId.equals(info.getSessionId()))
                .map(SessionTerminalTalent.BashSessionInfo::getOutput)
                .findFirst().orElse("");
    }

  private static String extractSessionId(String result) {
    if (result == null) return null;
    for (String line : result.split("\\R")) {
      if (line.startsWith("session_id: ")) return line.substring("session_id: ".length()).trim();
    }
    return null;
  }
}

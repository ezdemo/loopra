package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.VersionUpdateDTO;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * 在当前机器上直接下载并执行 Loopra 安装脚本。
 *
 * <p>更新器作为独立子进程运行，直接执行官方安装脚本。它不会停止或重启
 * 当前 Java 服务；文件更新完成后，用户重新打开 Loopra 才会加载新版本。</p>
 */
@Slf4j
@Component
public class VersionUpdateService {
    private static final String RELEASE_BASE =
            "https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/";
    private static final String DEFAULT_MIRROR = "https://gh-proxy.org";
    private static final Set<String> MIRROR_HOSTS = Set.of(
            "gh-proxy.org",
            "github.boki.moe",
            "wget.la",
            "gh.monlor.com",
            "fastgit.cc",
            "ghproxy.net",
            "ghfast.top",
            "gh-proxy.com",
            "down.npee.cn",
            "ghproxy.vip"
    );

    @FunctionalInterface
    interface ProcessStarter {
        Process start(ProcessBuilder builder) throws IOException;
    }

    private static final int MAX_LOG_BYTES = 64 * 1024;
    private static final Set<String> TERMINAL_STATES = Set.of("success", "failed", "stopped");

    private final ProcessStarter starter;
    private final String osName;
    private final Path userHome;
    private final Path codeSource;
    private Process process;
    private Path logFile;
    private Path statusFile;
    private String platform = "";
    private String target = "";
    private boolean stopped;

    public VersionUpdateService() {
        this(builder -> builder.start(), System.getProperty("os.name"),
                Path.of(System.getProperty("user.home")), codeSourcePath());
    }

    VersionUpdateService(ProcessStarter starter, String osName, Path userHome,
                         Path codeSource) {
        this.starter = starter;
        this.osName = osName == null ? "" : osName;
        this.userHome = userHome;
        this.codeSource = codeSource;
    }

    /**
     * 启动独立更新进程。当前服务保持运行，更新完成后由用户手动重启。
     */
    public synchronized VersionUpdateDTO start(String source) {
        if (isRunning()) throw new ServiceException("核心服务更新已在进行中");
        try {
            String normalizedOs = osName.toLowerCase(Locale.ROOT);
            boolean windows = normalizedOs.startsWith("windows");
            boolean unix = normalizedOs.contains("mac") || normalizedOs.contains("darwin")
                    || normalizedOs.contains("linux");
            if (!windows && !unix) throw new ServiceException("当前操作系统不支持自动更新");

            String mirror = normalizeMirror(source);
            boolean desktop = isDesktopRuntime(codeSource);
            String setupName = "setup" + (desktop ? "-gui" : "") + (windows ? ".ps1" : ".sh");
            String setupUrl = mirror.isEmpty()
                    ? RELEASE_BASE + setupName
                    : mirror + "/" + RELEASE_BASE + setupName;

            Path updateDir = userHome.resolve(".loopra").resolve("updates");
            Files.createDirectories(updateDir);
            String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS"));
            Path script = updateDir.resolve("update-" + stamp + (windows ? ".ps1" : ".sh"));
            logFile = updateDir.resolve("update-" + stamp + ".log");
            statusFile = updateDir.resolve("latest-update.txt");
            platform = osName;
            target = desktop ? "桌面端核心服务" : "核心服务";
            stopped = false;
            Files.deleteIfExists(statusFile);
            // Windows PowerShell 5.1 treats UTF-8 files without a BOM as ANSI.
            // Chinese messages then become invalid syntax, so the wrapper must
            // carry a UTF-8 BOM on Windows.
            String scriptContent = windows ? "\uFEFF" + windowsScript() : unixScript();
            Files.writeString(script, scriptContent, StandardCharsets.UTF_8);

            ProcessBuilder builder = windows
                    ? new ProcessBuilder("powershell.exe", "-NoProfile", "-NonInteractive",
                    "-ExecutionPolicy", "Bypass", "-File", script.toString())
                    : new ProcessBuilder("bash", script.toString());
            builder.directory(updateDir.toFile());
            builder.redirectErrorStream(true);
            builder.redirectOutput(logFile.toFile());
            builder.environment().put("LOOPRA_UPDATE_SETUP_URL", setupUrl);
            builder.environment().put("LOOPRA_UPDATE_LOG", logFile.toString());
            builder.environment().put("LOOPRA_UPDATE_STATUS", statusFile.toString());
            if (!mirror.isEmpty()) {
                builder.environment().put("LOOPRA_MIRROR", mirror);
                builder.environment().put("LOOPRA_UPDATE_MIRROR", mirror);
            } else {
                builder.environment().remove("LOOPRA_MIRROR");
                builder.environment().remove("LOOPRA_UPDATE_MIRROR");
            }
            process = starter.start(builder);
            if (process == null) throw new IOException("更新进程未能启动");
            writeState("starting", "正在准备核心更新");
            appendLog("[Loopra] 更新器已启动。\n");

            log.info("核心更新已启动: target={}, platform={}, log={}", target, osName, logFile);
            return snapshot();
        } catch (ServiceException error) {
            throw error;
        } catch (Exception error) {
            process = null;
            log.warn("启动核心更新失败", error);
            throw new ServiceException("无法启动核心更新: " + error.getMessage());
        }
    }

    /**
     * 返回当前更新任务状态、日志路径和最近的日志内容。
     */
    public synchronized VersionUpdateDTO status() {
        if (process == null) {
            return new VersionUpdateDTO(false, "idle", "", "", "", "", "暂无更新任务");
        }
        return snapshot();
    }

    /**
     * 停止当前更新进程及其子进程，保留已经输出的日志。
     */
    public synchronized VersionUpdateDTO stop() {
        if (!isRunning()) throw new ServiceException("当前没有正在进行的更新");
        stopped = true;
        stopProcessTree(process);
        writeState("stopped", "更新已停止");
        appendLog("[Loopra] 更新已停止。\n");
        log.info("核心更新已停止: log={}", logFile);
        return snapshot();
    }

    static String normalizeMirror(String source) {
        String value = source == null ? "" : source.trim();
        if (value.isEmpty() || "normal".equalsIgnoreCase(value)) return "";
        if ("mirror".equalsIgnoreCase(value)) return DEFAULT_MIRROR;
        try {
            URI uri = URI.create(value);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null
                    || !MIRROR_HOSTS.contains(host)) {
                throw new ServiceException("不支持该更新镜像");
            }
            return value.replaceAll("/+$", "");
        } catch (IllegalArgumentException error) {
            throw new ServiceException("更新镜像地址无效");
        }
    }

    private static boolean isDesktopRuntime(Path location) {
        if (location == null) return false;
        return location.toString().replace('\\', '/').toLowerCase(Locale.ROOT).contains("/.loopra-gui/");
    }

    private static Path codeSourcePath() {
        try {
            return Path.of(VersionUpdateService.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
        } catch (Exception ignored) {
            return Path.of("").toAbsolutePath();
        }
    }

    private static String windowsScript() {
        return """
                $ErrorActionPreference = 'Stop'
                $ProgressPreference = 'SilentlyContinue'
                $utf8 = New-Object System.Text.UTF8Encoding($false)
                [Console]::OutputEncoding = $utf8
                $OutputEncoding = $utf8
                $statusFile = $env:LOOPRA_UPDATE_STATUS
                $logFile = $env:LOOPRA_UPDATE_LOG
                function Set-UpdateState([string]$state, [string]$message) {
                    @($state, $message) | Set-Content -LiteralPath $statusFile -Encoding UTF8
                }

                Set-UpdateState 'starting' '正在准备核心更新'
                Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "[Loopra] 更新器已启动，当前服务保持运行。"

                try {
                    if ($env:LOOPRA_UPDATE_MIRROR) {
                        $env:LOOPRA_MIRROR = $env:LOOPRA_UPDATE_MIRROR
                }
                Set-UpdateState 'running' '正在下载并安装新版本'
                Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "[Loopra] 正在下载更新脚本: $env:LOOPRA_UPDATE_SETUP_URL"
                    $setupFile = Join-Path (Split-Path -Parent $logFile) 'download-setup.ps1'
                    Invoke-WebRequest -UseBasicParsing -Uri $env:LOOPRA_UPDATE_SETUP_URL -OutFile $setupFile
                    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $setupFile
                    if ($LASTEXITCODE -ne 0) {
                        throw "安装脚本退出码: $LASTEXITCODE"
                }
                Set-UpdateState 'success' '核心服务更新完成'
                Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "[Loopra] 核心服务更新完成。"
            } catch {
                Set-UpdateState 'failed' $_.Exception.Message
                Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "[Loopra] 更新失败: $($_.Exception.Message)"
                    exit 1
                }
                """;
    }

    private static String unixScript() {
        return """
                #!/usr/bin/env bash
                set -u
                status_file="$LOOPRA_UPDATE_STATUS"
                log_file="$LOOPRA_UPDATE_LOG"
                setup_file="$(mktemp)"
                trap 'rm -f "$setup_file"' EXIT

                write_state() {
                  printf '%s\n%s\n' "$1" "$2" > "$status_file"
                }

                write_state 'starting' '正在准备核心更新'
                echo "[Loopra] 更新器已启动，当前服务保持运行。" >> "$log_file"

                if [ -n "${LOOPRA_UPDATE_MIRROR:-}" ]; then
                  export LOOPRA_MIRROR="$LOOPRA_UPDATE_MIRROR"
                fi
                write_state 'running' '正在下载并安装新版本'
                echo "[Loopra] 正在下载更新脚本: $LOOPRA_UPDATE_SETUP_URL" >> "$log_file"
                if command -v curl >/dev/null 2>&1; then
                  if ! curl -fsSL "$LOOPRA_UPDATE_SETUP_URL" -o "$setup_file"; then
                    write_state 'failed' '下载更新脚本失败'
                    exit 1
                  fi
                elif command -v wget >/dev/null 2>&1; then
                  if ! wget -q "$LOOPRA_UPDATE_SETUP_URL" -O "$setup_file"; then
                    write_state 'failed' '下载更新脚本失败'
                    exit 1
                  fi
                else
                  write_state 'failed' '未找到 curl 或 wget'
                  exit 1
                fi

                if bash "$setup_file"; then
                  write_state 'success' '核心服务更新完成'
                  echo "[Loopra] 核心服务更新完成。" >> "$log_file"
                else
                  write_state 'failed' '安装脚本执行失败，请查看日志'
                  exit 1
                fi
                """;
    }

    private boolean isRunning() {
        return process != null && process.isAlive()
                && !TERMINAL_STATES.contains(readState()[0]);
    }

    private VersionUpdateDTO snapshot() {
        String[] stateAndMessage = readState();
        String state = stateAndMessage[0];
        String message = stateAndMessage[1];
        boolean alive = process != null && process.isAlive();
        if (stopped) {
            state = "stopped";
            message = "更新已停止";
        } else if (!alive && !TERMINAL_STATES.contains(state)) {
            state = "failed";
            message = "更新进程已退出，请查看日志";
        } else if (state.isEmpty()) {
            state = "starting";
            message = "正在准备核心更新";
        }
        boolean running = alive && !TERMINAL_STATES.contains(state);
        return new VersionUpdateDTO(running, state, platform, target,
                logFile == null ? "" : logFile.toString(), readLog(), message);
    }

    private String[] readState() {
        if (statusFile == null) return new String[]{"", ""};
        try {
            List<String> lines = Files.readAllLines(statusFile, StandardCharsets.UTF_8);
            String state = lines.isEmpty() ? "" : lines.get(0).replace("\uFEFF", "").trim().toLowerCase(Locale.ROOT);
            String message = lines.size() < 2 ? "" : lines.get(1).trim();
            return new String[]{state, message};
        } catch (Exception ignored) {
            return new String[]{"", ""};
        }
    }

    private void writeState(String state, String message) {
        if (statusFile == null) return;
        try {
            Files.writeString(statusFile, state + "\n" + message + "\n",
                    StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                    StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (Exception error) {
            log.debug("写入核心更新状态失败", error);
        }
    }

    private void appendLog(String text) {
        if (logFile == null) return;
        try {
            Files.writeString(logFile, text, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception error) {
            log.debug("写入核心更新日志失败", error);
        }
    }

    private String readLog() {
        if (logFile == null) return "";
        try {
            long size = Files.size(logFile);
            int length = (int) Math.min(size, MAX_LOG_BYTES);
            byte[] bytes = new byte[length];
            try (RandomAccessFile file = new RandomAccessFile(logFile.toFile(), "r")) {
                file.seek(size - length);
                file.readFully(bytes);
            }
            String content = new String(bytes, StandardCharsets.UTF_8).stripTrailing();
            return size > MAX_LOG_BYTES ? "…\n" + content : content;
        } catch (Exception ignored) {
            return "";
        }
    }

    private static void stopProcessTree(Process targetProcess) {
        List<ProcessHandle> descendants;
        try {
            descendants = targetProcess.descendants().toList();
        } catch (Exception ignored) {
            descendants = List.of();
        }
        descendants.forEach(ProcessHandle::destroy);
        targetProcess.destroy();
        try {
            if (!targetProcess.waitFor(2, TimeUnit.SECONDS)) {
                descendants.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
                targetProcess.destroyForcibly();
            }
        } catch (InterruptedException error) {
            descendants.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
            targetProcess.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }
}

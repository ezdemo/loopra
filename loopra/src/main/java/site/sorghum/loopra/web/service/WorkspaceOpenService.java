package site.sorghum.loopra.web.service;

import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/** Opens native applications on the service host, rooted at the selected project. */
@Component
public class WorkspaceOpenService {
    @Inject private AgentService agentService;
    private final Function<String, String> resolver;
    private final Function<String, Path> executable;
    private final ProcessStarter starter;
    private final String os;

    @FunctionalInterface interface ProcessStarter { Process start(ProcessBuilder builder) throws IOException; }

    public WorkspaceOpenService() {
        this(null, WorkspaceOpenService::findExecutable, ProcessBuilder::start, System.getProperty("os.name"));
    }

    WorkspaceOpenService(Function<String, String> resolver, Function<String, Path> executable, ProcessStarter starter, String os) {
        this.resolver = resolver; this.executable = executable; this.starter = starter;
        this.os = os.toLowerCase(Locale.ROOT);
    }

    public String open(String workspaceHash, String application) {
        if (workspaceHash == null || !workspaceHash.matches("[a-f0-9]{12}")) throw new ServiceException("请选择有效的项目");
        if (!List.of("folder", "powershell", "git-bash", "bash", "terminal").contains(application == null ? "" : application)) {
            throw new ServiceException("不支持的打开方式");
        }
        String resolved = resolver == null ? agentService.resolveProjectPath(workspaceHash) : resolver.apply(workspaceHash);
        if (resolved == null) throw new ServiceException("项目不存在，请刷新项目列表");
        Path directory = Path.of(resolved).toAbsolutePath().normalize();
        if (!Files.isDirectory(directory)) throw new ServiceException("项目文件夹不存在或无法访问");
        ProcessBuilder builder = command(directory, application);
        builder.directory(directory.toFile()).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD);
        try {
            Process process = starter.start(builder);
            // The Windows PowerShell launcher exits once it has created the visible window.
            // Explorer and terminal processes may remain alive after a successful launch.
            boolean launcher = builder.environment().containsKey("LOOPRA_OPEN_EXECUTABLE");
            if (launcher && !process.waitFor(10, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new ServiceException("启动终端超时，请重试");
            }
            if ((launcher || process.waitFor(200, TimeUnit.MILLISECONDS)) && process.exitValue() != 0
                    && !(application.equals("folder") && os.startsWith("windows") && process.exitValue() == 1)) {
                throw new ServiceException("无法启动所选终端，请检查程序安装和桌面环境");
            }
            return directory.toString();
        } catch (IOException error) {
            throw new ServiceException("无法打开所选应用，请检查程序安装和桌面环境");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ServiceException("打开项目已中断");
        }
    }

    private ProcessBuilder command(Path directory, String application) {
        if (application.equals("folder")) {
            return new ProcessBuilder(os.startsWith("windows") ? "explorer.exe" : os.startsWith("mac") ? "open" : "xdg-open", directory.toString());
        }
        if (os.startsWith("windows")) {
            if (application.equals("git-bash") || application.equals("bash")) {
                return new ProcessBuilder(require("git-bash.exe", "请先安装 Git for Windows（Git Bash）").toString(), "--cd=" + directory);
            }
            Path shell = executable.apply("pwsh.exe");
            if (shell == null) shell = require("powershell.exe", "未找到 PowerShell，请先安装");
            // Paths are data passed through the environment, never inserted into shell code.
            ProcessBuilder builder = new ProcessBuilder(require("powershell.exe", "未找到 PowerShell，请先安装").toString(), "-NoProfile", "-NonInteractive", "-Command",
                    "Start-Process -FilePath $env:LOOPRA_OPEN_EXECUTABLE -ArgumentList @('-NoLogo','-NoProfile','-NoExit') -WorkingDirectory $env:LOOPRA_OPEN_DIRECTORY -WindowStyle Normal -ErrorAction Stop");
            builder.environment().put("LOOPRA_OPEN_EXECUTABLE", shell.toString());
            builder.environment().put("LOOPRA_OPEN_DIRECTORY", directory.toString());
            return builder;
        }
        if (application.equals("git-bash")) throw new ServiceException("Git Bash 仅适用于 Windows，请选择 Bash 或终端");
        Path shell = application.equals("powershell") ? require("pwsh", "未找到 PowerShell，请先安装") : require("bash", "未找到 Bash，请先安装");
        if (os.startsWith("mac")) {
            String script = "on run argv\n tell application \"Terminal\"\n activate\n do script \"cd -- \" & quoted form of (item 1 of argv) & \"; exec \" & quoted form of (item 2 of argv)\n end tell\nend run";
            return new ProcessBuilder("osascript", "-e", script, directory.toString(), shell.toString());
        }
        if (!os.startsWith("linux")) throw new ServiceException("当前系统暂不支持打开终端");
        for (String terminal : List.of("gnome-terminal", "konsole", "xfce4-terminal", "x-terminal-emulator", "xterm")) {
            Path binary = executable.apply(terminal);
            if (binary == null) continue;
            List<String> command = new ArrayList<>(List.of(binary.toString()));
            if (terminal.equals("gnome-terminal")) command.addAll(List.of("--working-directory=" + directory, "--"));
            else if (terminal.equals("konsole")) command.addAll(List.of("--workdir", directory.toString(), "-e"));
            else if (terminal.equals("xfce4-terminal")) command.addAll(List.of("--working-directory=" + directory, "-x"));
            else command.add("-e");
            command.add(shell.toString());
            return new ProcessBuilder(command);
        }
        throw new ServiceException("未找到桌面终端，请安装终端程序后重试");
    }

    private Path require(String name, String error) {
        Path path = executable.apply(name);
        if (path == null) throw new ServiceException(error);
        return path;
    }

    private static Path findExecutable(String name) {
        List<Path> candidates = new ArrayList<>();
        String searchPath = System.getenv("PATH");
        for (String entry : (searchPath == null ? "" : searchPath).split(java.io.File.pathSeparator)) {
            if (entry.isBlank()) continue;
            Path directory = Path.of(entry.replace("\"", ""));
            candidates.add(directory.resolve(name));
            if (name.equals("git-bash.exe")) candidates.add(directory.resolve("../git-bash.exe").normalize());
        }
        if (name.equals("git-bash.exe")) {
            for (String variable : List.of("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")) {
                String base = System.getenv(variable);
                if (base != null) {
                    candidates.add(Path.of(base, "Git", name));
                    candidates.add(Path.of(base, "Programs", "Git", name));
                }
            }
        }
        return candidates.stream().filter(Files::isRegularFile).filter(Files::isExecutable).findFirst().orElse(null);
    }
}

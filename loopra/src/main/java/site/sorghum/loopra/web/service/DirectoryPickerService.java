package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/** Native directory selection on the machine running the Loopra service. */
@Component
@Slf4j
public class DirectoryPickerService {
    private final Semaphore active = new Semaphore(1);
    private final ProcessStarter starter;
    private final Duration timeout;

    @FunctionalInterface
    interface ProcessStarter { Process start(ProcessBuilder builder) throws IOException; }

    public DirectoryPickerService() { this(ProcessBuilder::start, Duration.ofMinutes(2)); }

    DirectoryPickerService(ProcessStarter starter, Duration timeout) {
        this.starter = starter;
        this.timeout = timeout;
    }

    public String pickDirectory(String initialPath) {
        if (!active.tryAcquire()) throw new ServiceException("目录选择窗口已打开，请先完成或取消当前选择");
        Path temporary = null;
        Process process = null;
        try {
            String platform = platform(System.getProperty("os.name"), System.getProperty("os.arch"));
            temporary = Files.createTempDirectory("loopra-directory-picker-");
            Path runtime = temporary.resolve("swt.jar");
            try (var source = DirectoryPickerService.class.getResourceAsStream("/native/swt/" + platform + ".jar")) {
                if (source == null) throw new ServiceException("目录选择组件未安装，请重新构建后端或手动输入项目文件夹路径");
                Files.copy(source, runtime);
            }
            Path result = temporary.resolve("selection.txt");
            Path output = temporary.resolve("dialog.log");
            List<String> command = new ArrayList<>();
            command.add(Path.of(System.getProperty("java.home"), "bin", platform.startsWith("win32") ? "javaw.exe" : "java").toString());
            // Solon defaults the server JVM to headless. The isolated SWT process
            // owns its display and must not use that flag to infer desktop availability.
            command.add("-Djava.awt.headless=false");
            if (platform.startsWith("macos")) command.add("-XstartOnFirstThread");
            command.add("-cp");
            // Prepend the chosen platform runtime; the application jar contains
            // the helper class but no unpacked platform-specific SWT classes.
            command.add(runtime + File.pathSeparator + System.getProperty("java.class.path"));
            command.add("site.sorghum.loopra.web.service.DirectoryPickerMain");
            command.add(result.toString());
            command.add(initialPath == null ? "" : initialPath.strip());
            process = starter.start(new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(output.toFile()));
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new ServiceException("选择目录超时，请重新打开选择窗口");
            }
            if (process.exitValue() != 0 || !Files.isRegularFile(result)) {
                log.warn("Native directory picker failed: {}", Files.exists(output) ? Files.readString(output) : process.exitValue());
                throw new ServiceException("无法打开系统目录选择窗口，请确认服务有可用桌面环境，或手动输入项目文件夹路径");
            }
            String selected = Files.readString(result, StandardCharsets.UTF_8);
            if (selected.isBlank()) return "";
            Path directory = Path.of(selected).toAbsolutePath().normalize();
            if (!Files.isDirectory(directory)) throw new ServiceException("选择的文件夹不存在或无法访问");
            return directory.toString();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ServiceException("目录选择已取消");
        } catch (IOException error) {
            log.warn("Cannot start directory picker", error);
            throw new ServiceException("无法启动目录选择窗口，请手动输入项目文件夹路径");
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
                try { process.waitFor(3, TimeUnit.SECONDS); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
            if (temporary != null) {
                try (var paths = Files.walk(temporary)) {
                    for (Path entry : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(entry);
                } catch (IOException error) { log.debug("Cannot clean directory picker temporary files", error); }
            }
            active.release();
        }
    }

    static String platform(String osName, String architecture) {
        String os = osName.toLowerCase(Locale.ROOT);
        String arch = architecture.toLowerCase(Locale.ROOT);
        arch = switch (arch) {
            case "amd64", "x86_64" -> "x86_64";
            case "aarch64", "arm64" -> "aarch64";
            default -> throw new ServiceException("当前系统架构暂不支持目录选择，请手动输入项目文件夹路径");
        };
        if (os.startsWith("windows") && arch.equals("x86_64")) return "win32-" + arch;
        if (os.startsWith("mac") || os.startsWith("darwin")) return "macos-" + arch;
        if (os.startsWith("linux")) return "linux-" + arch;
        throw new ServiceException("当前系统暂不支持目录选择，请手动输入项目文件夹路径");
    }
}

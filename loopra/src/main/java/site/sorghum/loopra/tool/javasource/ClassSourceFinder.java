package site.sorghum.loopra.tool.javasource;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Java 源码解析器 —— 三阶段查找：项目树 → ~/.m2 + ~/.gradle jar 缓存 → javap 反编译。
 * <p>
 * 移植自 DeepSeek-Reasonix TypeScript 实现。
 * </p>
 *
 * <h3>查找策略</h3>
 * <ol>
 *   <li>遍历项目树，匹配简单类名的 {@code .java} 文件。</li>
 *   <li>遍历 {@code ~/.m2/repository} 和 {@code ~/.gradle/caches}，
 *       路径中包含 {@code jarKeyword}（忽略大小写）的 jar 包。</li>
 *   <li>优先使用源码 jar（{@code -sources.jar}）——直接读取 {@code .java}。</li>
 *   <li>回退到普通 jar —— 提取 {@code .class} 并通过 {@code javap -c -p} 反编译。</li>
 * </ol>
 *
 * @author Sorghum
 */
@Slf4j
public class ClassSourceFinder {

    // ── 类型定义 ────────────────────────────────────────────────────────────

    /**
     * 源码来源方式。
     */
    @Getter
    public enum Method {
        /** 项目源码文件 */
        PROJECT("project"),
        /** Maven 源码 jar */
        M2_SOURCE_JAR("m2-source-jar"),
        /** Maven 普通 jar（javap 反编译） */
        M2_JAR("m2-jar"),
        /** 指定 jar 文件 */
        JAR("jar"),
        /** 未找到 */
        NOT_FOUND("not-found");

        private final String label;

        Method(String label) {
            this.label = label;
        }
    }

    /**
     * {@link #findSource(String, String)} 的不可变查找结果。
     */
    public record FindResult(boolean found, String source, Method method, String sourcePath, String className) {

        /** 未找到的快捷工厂方法。 */
        public static FindResult notFound() {
            return new FindResult(false, null, Method.NOT_FOUND, null, null);
        }

        /** 查找成功的快捷工厂方法。 */
        public static FindResult success(String source, Method method, String sourcePath, String className) {
            return new FindResult(true, source, method, sourcePath, className);
        }

        /**
         * 转为 Map，方便通过 snack4 ONode 序列化为 JSON。
         */
        public Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("status", found ? "found" : "not-found");
            map.put("className", className);
            if (found) {
                map.put("method", method.getLabel());
                map.put("sourcePath", sourcePath);
                map.put("source", source);
            } else {
                map.put("message", source);
            }
            return map;
        }
    }

    // ── 配置 ─────────────────────────────────────────────────────────────────

    /** 项目根目录 */
    private final Path projectRoot;
    /** jar 仓库目录列表（~/.m2/repository、~/.gradle/caches 等） */
    private final List<Path> repoPaths;
    /** javap 命令路径 */
    private final String javapCommand;
    /** 最大扫描 jar 数量（防止 IO 风暴） */
    private final int maxJarScan;

    /** 项目树遍历时跳过的目录。 */
    private static final Set<String> SKIP_DIRS = Set.of(
            "node_modules", ".git", "target", "build", "dist", ".idea", ".vscode", ".gradle"
    );

    /** 仓库缓存递归深度上限。 */
    private static final int MAX_WALK_DEPTH = 64;

    // ── 构造方法 ────────────────────────────────────────────────────────────

    /**
     * 自动检测用户目录下的 Maven 和 Gradle 仓库路径。
     */
    public static List<Path> defaultRepoPaths() {
        String home = System.getProperty("user.home");
        List<Path> paths = new ArrayList<>();
        if (home != null) {
            Path m2 = Path.of(home, ".m2", "repository");
            if (Files.exists(m2)) {
                paths.add(m2);
            }
            Path gradle = Path.of(home, ".gradle", "caches");
            if (Files.exists(gradle)) {
                paths.add(gradle);
            }
        }
        return paths;
    }

    /**
     * 使用默认配置创建查找器。
     *
     * @param projectRoot 项目根目录，用于搜索 .java 文件
     */
    public ClassSourceFinder(Path projectRoot) {
        this(projectRoot, defaultRepoPaths(), "javap", 2000);
    }

    /**
     * 使用完整参数创建查找器。
     *
     * @param projectRoot  项目根目录
     * @param repoPaths    jar 仓库目录（null 或空时自动检测）
     * @param javapCommand javap 可执行文件路径或命令名
     * @param maxJarScan   最大扫描 jar 数
     */
    public ClassSourceFinder(Path projectRoot, List<Path> repoPaths, String javapCommand, int maxJarScan) {
        this.projectRoot = projectRoot.toAbsolutePath().normalize();
        this.repoPaths = (repoPaths != null && !repoPaths.isEmpty()) ? repoPaths : defaultRepoPaths();
        this.javapCommand = (javapCommand != null && !javapCommand.isBlank()) ? javapCommand : "javap";
        this.maxJarScan = maxJarScan > 0 ? maxJarScan : 2000;
    }

    // ── 公开 API ────────────────────────────────────────────────────────────

    /**
     * 根据全限定类名查找 Java 源码。
     * <p>
     * 先在项目树中匹配 {@code .java} 文件，找不到则搜索 Maven/Gradle
     * 本地缓存中的 jar 包。
     * </p>
     *
     * @param fullyQualifiedName 全限定类名，如 "com.google.common.collect.Lists"
     * @param jarKeyword         用于过滤 jar 路径的关键字（忽略大小写，必填）
     * @return 查找结果，通过 {@link FindResult#found()} 判断是否成功
     * @throws IOException 搜索过程中发生 I/O 错误时抛出
     */
    public FindResult findSource(String fullyQualifiedName, String jarKeyword) throws IOException {
        // 第一阶段：搜索项目树
        FindResult projectResult = searchProject(fullyQualifiedName);
        if (projectResult != null) {
            return projectResult;
        }
        // 第二阶段：搜索本地仓库 jar
        return searchRepositories(fullyQualifiedName, jarKeyword);
    }

    /**
     * 在指定 jar 文件中查找类的源码（绕过常规搜索流程）。
     *
     * @param fullyQualifiedName 全限定类名
     * @param jarPath            jar 文件路径
     * @return 查找结果
     */
    public FindResult findSourceInJar(String fullyQualifiedName, Path jarPath) {
        if (!Files.exists(jarPath)) {
            return FindResult.notFound();
        }

        String classEntry = fullyQualifiedName.replace('.', '/') + ".class";
        try {
            ZipReader.JarEntry entry = ZipReader.readJarEntry(jarPath.toString(), classEntry);
            if (entry == null) {
                return FindResult.notFound();
            }
            String source = decompileFromJar(entry.data(), fullyQualifiedName);
            return FindResult.success(source, Method.JAR, jarPath.toString(), fullyQualifiedName);
        } catch (Exception e) {
            log.warn("从 jar {} 读取/反编译 {} 失败: {}", jarPath, fullyQualifiedName, e.getMessage());
            return FindResult.notFound();
        }
    }

    // ── 项目树搜索 ──────────────────────────────────────────────────────────

    /**
     * BFS 遍历项目树，查找文件名与简单类名匹配的 {@code .java} 文件。
     */
    private FindResult searchProject(String fqn) throws IOException {
        String simpleName = simpleClassName(fqn);
        String[] suffixes = {simpleName + ".java", simpleName + ".java.txt"};

        Deque<Path> queue = new ArrayDeque<>();
        queue.add(projectRoot);

        while (!queue.isEmpty()) {
            Path dir = queue.poll();
            if (!Files.isDirectory(dir)) {
                continue;
            }

            try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
                for (Path entry : stream) {
                    if (Files.isDirectory(entry)) {
                        String name = entry.getFileName().toString();
                        if (!SKIP_DIRS.contains(name)) {
                            queue.add(entry);
                        }
                    } else if (Files.isRegularFile(entry)) {
                        String name = entry.getFileName().toString();
                        for (String suffix : suffixes) {
                            if (name.equals(suffix)) {
                                String source = Files.readString(entry);
                                return FindResult.success(source, Method.PROJECT, entry.toString(), fqn);
                            }
                        }
                    }
                }
            }
        }
        return null;
    }

    // ── 仓库搜索 ────────────────────────────────────────────────────────────

    /**
     * 在 Maven/Gradle 本地缓存中搜索 jar 包。
     * <p>
     * 两遍策略：
     * <ol>
     *   <li>源码 jar（{@code -sources.jar}）——直接读取 {@code .java} 条目。</li>
     *   <li>普通 jar —— 提取 {@code .class} 并通过 javap 反编译。</li>
     * </ol>
     * </p>
     */
    private FindResult searchRepositories(String fqn, String jarKeyword) throws IOException {
        String javaEntry = fqn.replace('.', '/') + ".java";
        String classEntry = fqn.replace('.', '/') + ".class";

        List<Path> sourceJars = new ArrayList<>();
        List<Path> regularJars = new ArrayList<>();

        for (Path repoDir : repoPaths) {
            if (Files.isDirectory(repoDir)) {
                walkForJars(repoDir, sourceJars, regularJars, jarKeyword);
            }
        }

        // 第一遍：优先使用源码 jar（无需反编译，直接读取 .java）
        for (Path jarPath : sourceJars) {
            try {
                String content = ZipReader.readJarEntryAsString(jarPath.toString(), javaEntry);
                if (content != null) {
                    return FindResult.success(content, Method.M2_SOURCE_JAR, jarPath.toString(), fqn);
                }
            } catch (Exception e) {
                log.debug("跳过无法读取的源码 jar {}: {}", jarPath, e.getMessage());
            }
        }

        // 第二遍：回退到普通 jar，通过 javap 反编译 .class
        int scanned = 0;
        for (Path jarPath : regularJars) {
            if (scanned >= maxJarScan) {
                break;
            }
            scanned++;

            try {
                ZipReader.JarEntry entry = ZipReader.readJarEntry(jarPath.toString(), classEntry);
                if (entry != null) {
                    String source = decompileFromJar(entry.data(), fqn);
                    return FindResult.success(source, Method.M2_JAR, jarPath.toString(), fqn);
                }
            } catch (Exception e) {
                log.debug("跳过 jar {}: {}", jarPath, e.getMessage());
            }
        }

        return FindResult.notFound();
    }

    /**
     * 递归遍历目录，收集 jar 文件路径（可按关键字过滤）。
     */
    private void walkForJars(Path dir, List<Path> sourceJars, List<Path> regularJars, String keyword)
            throws IOException {
        walkForJars(dir, sourceJars, regularJars, keyword, 0);
    }

    private void walkForJars(Path dir, List<Path> sourceJars, List<Path> regularJars,
                             String keyword, int depth) throws IOException {
        if (depth >= MAX_WALK_DEPTH) {
            return;
        }
        if (sourceJars.size() + regularJars.size() >= maxJarScan) {
            return;
        }
        if (!Files.isDirectory(dir)) {
            return;
        }

        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path entry : stream) {
                if (sourceJars.size() + regularJars.size() >= maxJarScan) {
                    return;
                }

                if (Files.isDirectory(entry)) {
                    walkForJars(entry, sourceJars, regularJars, keyword, depth + 1);
                } else if (Files.isRegularFile(entry)) {
                    String name = entry.getFileName().toString();
                    if (!name.endsWith(".jar")) {
                        continue;
                    }

                    // 关键字过滤：对完整路径做忽略大小写的子串匹配
                    if (keyword != null && !keyword.isBlank()) {
                        if (!entry.toString().toLowerCase().contains(keyword.toLowerCase())) {
                            continue;
                        }
                    }

                    if (name.endsWith("-sources.jar") || name.contains("-sources-")) {
                        sourceJars.add(entry);
                    } else {
                        regularJars.add(entry);
                    }
                }
            }
        }
    }

    // ── javap 反编译 ────────────────────────────────────────────────────────

    /**
     * 将 .class 字节提取到临时目录，然后用 javap -c -p 反编译。
     */
    private String decompileFromJar(byte[] classBytes, String fqn) {
        Path tmpDir = null;
        try {
            tmpDir = Files.createTempDirectory("loopra-java-src-");
            String pkgPath = fqn.replace('.', '/');
            Path classDir = tmpDir.resolve(pkgPath).getParent();
            if (classDir != null) {
                Files.createDirectories(classDir);
            }
            Path classFile = tmpDir.resolve(pkgPath + ".class");
            Files.write(classFile, classBytes);

            String raw = runJavap(fqn, tmpDir);
            return compressJavapOutput(raw);
        } catch (Exception e) {
            log.warn("反编译 {} 失败: {}", fqn, e.getMessage());
            return "// 反编译 " + fqn + " 失败: " + e.getMessage();
        } finally {
            if (tmpDir != null) {
                try {
                    deleteRecursive(tmpDir);
                } catch (IOException e) {
                    log.debug("清理临时目录 {} 失败: {}", tmpDir, e.getMessage());
                }
            }
        }
    }

    /**
     * 执行 {@code javap -c -p -cp <classPath> <className>}。
     */
    private String runJavap(String className, Path classPath) throws IOException, InterruptedException {
        ProcessBuilder pb = new ProcessBuilder(
                javapCommand, "-c", "-p", "-cp", classPath.toString(), className
        );
        pb.redirectErrorStream(true);

        Process process = pb.start();
        String output;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            output = reader.lines().collect(Collectors.joining("\n"));
        }

        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new IOException("javap 超时（30s），类: " + className);
        }

        // javap 在类缺失或不支持的字节码时退出码非零
        if (process.exitValue() != 0 && output.isBlank()) {
            throw new IOException("javap 退出码 " + process.exitValue() + "，类: " + className);
        }

        return output;
    }

    // ── javap 输出压缩 ──────────────────────────────────────────────────────

    /**
     * 从 javap 输出中剥离常量池定义、调试表（LineNumberTable /
     * LocalVariableTable / StackMapTable）以及 "Compiled from …" 前导信息。
     * <p>
     * 可减少约 60-80% 的 token，同时保留方法签名和字节码指令供 AI 消费。
     * </p>
     */
    public static String compressJavapOutput(String raw) {
        String[] lines = raw.split("\n");
        StringBuilder out = new StringBuilder(raw.length());
        Integer skipUntilIndent = null;

        for (String line : lines) {
            // 常量池条目行，形如 "   #1 = Methodref ..."
            if (line.matches("^\\s+#\\d+\\s*=.*")) {
                continue;
            }

            // 处于调试表体内部 —— 跳过比表头缩进更深的行
            if (skipUntilIndent != null) {
                int indent = countLeadingSpaces(line);
                if (indent > skipUntilIndent) {
                    continue;
                }
                skipUntilIndent = null;
                // 同时跳过表体后的空行
                if (line.isBlank()) {
                    continue;
                }
            }

            // 调试表头 —— 记录缩进深度，后续体部行都将被跳过
            if (line.matches("^\\s+(LineNumberTable|LocalVariableTable|StackMapTable):.*")) {
                skipUntilIndent = countLeadingSpaces(line);
                continue;
            }

            // "Compiled from …" 前导信息
            if (line.startsWith("Compiled from ")) {
                continue;
            }

            out.append(line).append('\n');
        }

        // 合并多余的连续空行
        return out.toString().replaceAll("\n{3,}", "\n\n").trim();
    }

    /** 统计行首空格数。 */
    private static int countLeadingSpaces(String s) {
        int count = 0;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == ' ') {
                count++;
            } else {
                break;
            }
        }
        return count;
    }

    // ── 工具方法 ────────────────────────────────────────────────────────────

    /** 从全限定类名中提取简单类名。 */
    private static String simpleClassName(String fqn) {
        int lastDot = fqn.lastIndexOf('.');
        return lastDot == -1 ? fqn : fqn.substring(lastDot + 1);
    }

    /** 递归删除目录及其内容。 */
    private static void deleteRecursive(Path path) throws IOException {
        if (Files.isDirectory(path)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
                for (Path entry : stream) {
                    deleteRecursive(entry);
                }
            }
        }
        Files.deleteIfExists(path);
    }
}

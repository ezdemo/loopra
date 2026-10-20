package site.sorghum.loopra.web.service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** Shared desktop PATH fallbacks for npm-based ACP providers. Never invokes a shell. */
final class AcpRuntimePaths {
    private AcpRuntimePaths() {}

    static List<Path> systemRoots(boolean windows) {
        return windows ? List.of() : List.of(Path.of("/opt/homebrew/bin"), Path.of("/usr/local/bin"),
                Path.of("/usr/bin"), Path.of("/bin"));
    }

    static List<Path> searchRoots(Map<String, String> env, Path home, List<Path> systemRoots) {
        List<Path> roots = new ArrayList<>();
        addPath(roots, environment(env, "NVM_BIN"));
        addPath(roots, environment(env, "NVM_SYMLINK"));
        addPath(roots, environment(env, "NODE_HOME"));
        String path = environment(env, "PATH");
        if (path != null) for (String part : path.split(java.io.File.pathSeparator)) addPath(roots, part);
        roots.add(home.resolve(".local/bin"));
        roots.add(home.resolve(".npm-global/bin"));
        roots.add(home.resolve(".nvm/current/bin"));
        String prefix = environment(env, "NPM_CONFIG_PREFIX");
        int size = roots.size();
        addPath(roots, prefix);
        if (roots.size() > size) roots.add(roots.get(roots.size() - 1).resolve("bin"));
        roots.addAll(systemRoots);
        String appData = environment(env, "APPDATA");
        if (appData != null) addPath(roots, Path.of(appData).resolve("npm").toString());
        String programFiles = environment(env, "ProgramFiles");
        if (programFiles != null) addPath(roots, Path.of(programFiles).resolve("nodejs").toString());
        return roots;
    }

    static Path node(List<Path> roots, Map<String, String> env, boolean windows) {
        String override = environment(env, "LOOPRA_NODE_EXECUTABLE");
        Path node = null;
        if (override != null && !override.isBlank()) {
            Path file = Path.of(override);
            if (Files.isRegularFile(file) && (windows || Files.isExecutable(file))) node = file;
        } else {
            for (Path root : List.copyOf(roots)) {
                Path file = root.resolve(windows ? "node.exe" : "node");
                if (Files.isRegularFile(file) && (windows || Files.isExecutable(file))) {
                    node = file.toAbsolutePath().normalize(); break;
                }
            }
        }
        if (node != null) {
            roots.add(node.toAbsolutePath().getParent());
            try { roots.add(node.toRealPath().getParent()); } catch (java.io.IOException ignored) {}
        }
        return node;
    }

    static Path adapter(List<Path> roots, Path home, boolean windows, String override,
                        String command, List<String> packages) {
        if (override != null && !override.isBlank()) return Path.of(override).toAbsolutePath().normalize();
        List<Path> candidates = new ArrayList<>(roots);
        candidates.add(home.resolve(".npm-global/lib"));
        for (Path root : candidates) {
            if (!windows) {
                try {
                    Path linked = root.resolve(command).toRealPath();
                    if (Files.isRegularFile(linked) && linked.toString().endsWith(".js")) return linked;
                } catch (java.io.IOException ignored) {}
            }
            for (Path base : List.of(root, root.resolve("../lib").normalize())) {
                for (String pkg : packages) {
                    Path script = base.resolve("node_modules").resolve(pkg).resolve("dist/index.js");
                    if (Files.isRegularFile(script)) return script.toAbsolutePath().normalize();
                }
            }
        }
        return null;
    }

    static Map<String, String> withNodePath(Path node, Map<String, String> source, boolean windows) {
        Map<String, String> env = new HashMap<>(source);
        String key = windows ? source.keySet().stream().filter(name -> name.equalsIgnoreCase("PATH"))
                .findFirst().orElse("PATH") : "PATH";
        String path = windows ? environment(source, "PATH") : source.get("PATH");
        if (windows) env.keySet().removeIf(name -> name.equalsIgnoreCase("PATH"));
        env.put(key, node.toAbsolutePath().getParent() + (path == null || path.isBlank() ? "" : (windows ? ";" : ":") + path));
        return env;
    }

    static String environment(Map<String, String> env, String key) {
        return env.entrySet().stream().filter(entry -> entry.getKey().equalsIgnoreCase(key))
                .map(Map.Entry::getValue).findFirst().orElse(null);
    }

    private static void addPath(List<Path> paths, String value) {
        if (value == null || value.isBlank()) return;
        value = value.trim();
        if (value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1, value.length() - 1);
        try { paths.add(Path.of(value)); } catch (java.nio.file.InvalidPathException ignored) {}
    }
}

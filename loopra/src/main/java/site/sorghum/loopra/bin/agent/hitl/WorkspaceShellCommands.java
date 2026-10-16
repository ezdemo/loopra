package site.sorghum.loopra.bin.agent.hitl;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** 可直接确定目标位置的工作区命令；脚本或无法确定目标的操作仍交给审批。 */
public final class WorkspaceShellCommands {
    private WorkspaceShellCommands() { }

    public static boolean isWorkspaceLocal(String command, Path workspace, Path directory) {
        if (!WorkspaceFileOperations.isWithin(workspace, workspace, directory == null ? null : directory.toString())) {
            return false;
        }
        List<List<String>> commands = ReadOnlyShellCommands.tokenize(command, true);
        return !commands.isEmpty() && commands.stream().allMatch(tokens -> isLocal(tokens, workspace, directory));
    }

    private static boolean isLocal(List<String> tokens, Path workspace, Path directory) {
        List<String> arguments = new ArrayList<>();
        for (int i = 0; i < tokens.size(); i++) {
            String token = tokens.get(i);
            if (token.equals(">") || token.equals(">>")) {
                if (++i >= tokens.size() || !isLocalPath(workspace, directory, tokens.get(i))) {
                    return false;
                }
            } else arguments.add(token);
        }
        if (arguments.isEmpty()) return false;
        String name = arguments.get(0).toLowerCase(Locale.ROOT);
        if (ReadOnlyShellCommands.isQuery(arguments)) return true;
        if (Set.of("echo", "printf").contains(name)) return true;
        if (Set.of("set-content", "add-content", "new-item", "copy-item", "move-item").contains(name)) {
            return isPowerShellWrite(arguments, workspace, directory);
        }
        if (!Set.of("mkdir", "touch", "cp", "mv", "copy", "move").contains(name)) return false;
        List<String> paths = new ArrayList<>();
        boolean positionalOnly = false;
        for (String argument : arguments.subList(1, arguments.size())) {
            if (!positionalOnly && argument.equals("--")) {
                positionalOnly = true;
            } else if (!positionalOnly && argument.startsWith("-")) {
                // 仅支持不会引入第二个目标路径、外部程序或隐式脚本的选项。
                if (!Set.of("-p", "-r", "-R", "-f", "-n", "-v", "--parents", "--recursive",
                        "--force", "--no-clobber", "--verbose").contains(argument)) return false;
            } else {
                paths.add(argument);
            }
        }
        if (paths.isEmpty()) return false;
        return paths.stream().allMatch(path -> isLocalPath(workspace, directory, path));
    }

    /** 确定存在越界写入目标时，直接转人工，不能让校验模型覆盖路径边界。 */
    public static boolean hasOutsideTarget(String command, Path workspace, Path directory) {
        for (List<String> tokens : ReadOnlyShellCommands.tokenize(command, true)) {
            for (int i = 0; i < tokens.size(); i++) {
                String token = tokens.get(i);
                if (Set.of(">", ">>", "-path", "-literalpath", "-destination").contains(token.toLowerCase(Locale.ROOT))
                        && i + 1 < tokens.size() && !isLocalPath(workspace, directory, tokens.get(i + 1))) {
                    return true;
                }
            }
            if (Set.of("mkdir", "touch", "cp", "mv", "copy", "move").contains(tokens.get(0).toLowerCase(Locale.ROOT))) {
                for (String argument : tokens.subList(1, tokens.size())) {
                    if (!argument.startsWith("-") && !isLocalPath(workspace, directory, argument)) return true;
                }
            }
        }
        return false;
    }

    private static boolean isPowerShellWrite(List<String> tokens, Path workspace, Path directory) {
        boolean source = false;
        boolean destination = false;
        boolean copying = Set.of("copy-item", "move-item").contains(tokens.get(0).toLowerCase(Locale.ROOT));
        for (int i = 1; i < tokens.size(); i++) {
            String option = tokens.get(i).toLowerCase(Locale.ROOT);
            if (Set.of("-path", "-literalpath", "-destination").contains(option)) {
                if (++i >= tokens.size() || !isLocalPath(workspace, directory, tokens.get(i))) return false;
                if (option.equals("-destination")) destination = true;
                else source = true;
            } else if (option.equals("-value") && !copying) {
                if (++i >= tokens.size() || tokens.get(i).startsWith("-")) return false;
            } else if (option.equals("-itemtype") && tokens.get(0).equalsIgnoreCase("new-item")) {
                if (++i >= tokens.size() || !Set.of("file", "directory").contains(tokens.get(i).toLowerCase(Locale.ROOT))) {
                    return false;
                }
            } else if (option.equals("-encoding") && !copying) {
                if (++i >= tokens.size() || !Set.of("utf8", "utf8nobom", "utf8bom", "unicode", "ascii")
                        .contains(tokens.get(i).toLowerCase(Locale.ROOT))) return false;
            } else if (!Set.of("-force", "-recurse").contains(option)) return false;
        }
        return source && (!copying || destination);
    }

    private static boolean isLocalPath(Path workspace, Path directory, String path) {
        // PowerShell 会把未加引号的逗号展开成路径数组；保守地交给审批。
        return !path.matches(".*[,?*\\[\\]].*") && WorkspaceFileOperations.isWithin(workspace, directory, path);
    }
}

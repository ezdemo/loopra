package site.sorghum.loopra.bin.agent.hitl;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** 只识别明确的查询命令；未知语法或选项交给原有审批流程。 */
public final class ReadOnlyShellCommands {
    private ReadOnlyShellCommands() { }

    private static final Set<String> GIT_OPTIONS = Set.of(
            "--short", "--branch", "--porcelain", "--show-stash", "--ignored",
            "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--check",
            "--cached", "--staged", "--raw", "--summary", "--compact-summary", "--no-index",
            "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative",
            "--quiet", "--exit-code", "--oneline", "--decorate", "--no-decorate",
            "--graph", "--all", "--date-order", "--reverse", "--follow", "--no-patch",
            "--patch", "--abbrev-commit", "--no-abbrev-commit", "--no-show-signature",
            "--ignore-space-at-eol", "--ignore-all-space", "--ignore-space-change",
            "--max-count", "-n", "-s", "-b", "-u", "-p", "-w");
    private static final Set<String> SEARCH_OPTIONS = Set.of(
            "--hidden", "--files", "--no-ignore", "--no-ignore-vcs", "--no-heading", "--heading",
            "--line-number", "--column", "--count", "--count-matches", "--files-with-matches",
            "--files-without-match", "--fixed-strings", "--ignore-case", "--case-sensitive",
            "--smart-case", "--word-regexp", "--line-regexp", "--invert-match", "--quiet",
            "--json", "--stats", "--max-count", "--max-depth", "--glob", "--iglob",
            "--type", "--type-not", "--regexp", "--file", "--context", "--before-context",
            "--after-context", "--color=never", "--color=always", "--color=auto",
            "--no-messages", "--with-filename", "--no-filename", "--only-matching");

    public static boolean isReadOnly(String command) {
        List<List<String>> commands = tokenize(command);
        return !commands.isEmpty() && commands.stream().allMatch(ReadOnlyShellCommands::isQuery);
    }

    static boolean isQuery(List<String> tokens) {
        String executable = tokens.get(0).toLowerCase(Locale.ROOT);
        if (executable.equals("git")) return isGitQuery(tokens);
        Set<String> options = switch (executable) {
            case "pwd", "get-location" -> Set.of("-L", "-P");
            case "ls", "dir", "get-childitem" -> Set.of(
                    "--all", "--almost-all", "--human-readable", "--directory", "--recursive",
                    "--color=never", "--color=auto", "--color=always",
                    "-Path", "-LiteralPath", "-Filter", "-Include", "-Exclude", "-Recurse",
                    "-Force", "-Name", "-Directory", "-File", "-Hidden", "-Depth");
            case "cat", "head", "tail", "wc", "get-content" -> Set.of(
                    "--number", "--number-nonblank", "--squeeze-blank", "--lines", "--bytes",
                    "--words", "--chars", "--max-line-length", "--quiet", "--verbose",
                    "-Path", "-LiteralPath", "-TotalCount", "-Tail", "-Raw", "-Encoding");
            case "rg", "grep" -> SEARCH_OPTIONS;
            case "find" -> Set.of("-name", "-iname", "-path", "-ipath", "-type", "-maxdepth",
                    "-mindepth", "-print", "-print0", "-empty", "-size", "-mtime");
            default -> null;
        };
        if (options == null) return false;
        return validOptions(tokens.subList(1, tokens.size()), option -> options.contains(option)
                || (Set.of("ls", "dir", "get-childitem").contains(executable)
                    && option.matches("-[aAlhRdtrSF1]+"))
                || (Set.of("cat", "head", "tail", "wc").contains(executable)
                    && option.matches("-[nbsvETAlcmwq0-9]+"))
                || (Set.of("rg", "grep").contains(executable)
                    && (option.matches("-[nrilLIvowscFHhqaS]+")
                        || option.matches("-[ABCm][0-9]+")
                        || Set.of("-e", "-f", "-g", "-t", "-T", "-A", "-B", "-C", "-m").contains(option))));
    }

    private static boolean isGitQuery(List<String> tokens) {
        int verb = 1;
        while (verb < tokens.size()
                && Set.of("--no-pager", "--no-optional-locks").contains(tokens.get(verb))) verb++;
        if (verb >= tokens.size()
                || !Set.of("status", "diff", "log", "show", "ls-files", "ls-tree").contains(tokens.get(verb))) {
            return false;
        }
        return validOptions(tokens.subList(verb + 1, tokens.size()), option -> GIT_OPTIONS.contains(option)
                || option.matches("-[0-9]+") || option.matches("-[nU][0-9]+")
                || option.matches("--(max-count|unified)=[0-9]+")
                || option.matches("--porcelain=(v1|v2|1|2)")
                || option.matches("--untracked-files=(no|normal|all)")
                || option.matches("--ignored=(traditional|matching|no)")
                || option.matches("--color=(never|auto|always)"));
    }

    private static boolean validOptions(List<String> arguments, java.util.function.Predicate<String> allowed) {
        for (String argument : arguments) {
            if (argument.equals("--")) return true;
            if (argument.startsWith("-") && !allowed.test(argument)) return false;
        }
        return true;
    }

    /** 不解释变量、替换、重定向、转义及通配符；复合命令的每一段都必须为查询。 */
    private static List<List<String>> tokenize(String command) {
        return tokenize(command, false);
    }

    static List<List<String>> tokenize(String command, boolean allowOutputRedirect) {
        if (command == null || command.isBlank()) return List.of();
        List<List<String>> commands = new ArrayList<>();
        List<String> tokens = new ArrayList<>();
        StringBuilder token = new StringBuilder();
        char quote = 0;
        boolean started = false;
        for (int i = 0; i < command.length(); i++) {
            char c = command.charAt(i);
            if ("$`<^%!\r\n\0(){}".indexOf(c) >= 0 || c == '>' && !allowOutputRedirect) return List.of();
            if (c == '\\' && i + 1 < command.length()
                    && (command.charAt(i + 1) == '\'' || command.charAt(i + 1) == '"')) return List.of();
            if (quote != 0) {
                if (c == quote) quote = 0;
                else token.append(c);
                continue;
            }
            if (c == '>' && allowOutputRedirect) {
                if (started) {
                    tokens.add(token.toString());
                    token.setLength(0);
                    started = false;
                }
                if (i + 1 < command.length() && command.charAt(i + 1) == '>') {
                    tokens.add(">>");
                    i++;
                } else tokens.add(">");
            } else if (c == '\'' || c == '"') {
                quote = c;
                started = true;
            } else if (Character.isWhitespace(c) || c == ';' || c == '|' || c == '&') {
                if (started) {
                    tokens.add(token.toString());
                    token.setLength(0);
                    started = false;
                }
                if (!Character.isWhitespace(c)) {
                    if (tokens.isEmpty()) return List.of();
                    commands.add(List.copyOf(tokens));
                    tokens.clear();
                    if (c == '&') {
                        if (i + 1 >= command.length() || command.charAt(++i) != '&') return List.of();
                    } else if (c == '|' && i + 1 < command.length() && command.charAt(i + 1) == '|') i++;
                }
            } else {
                if ("*?[]\\@".indexOf(c) >= 0) return List.of();
                token.append(c);
                started = true;
            }
        }
        if (quote != 0) return List.of();
        if (started) tokens.add(token.toString());
        if (tokens.isEmpty()) return List.of();
        commands.add(List.copyOf(tokens));
        return commands;
    }
}

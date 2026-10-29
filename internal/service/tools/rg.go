package tools

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/infrastructure/processtree"
	"github.com/ezdemo/looprax/internal/infrastructure/ripgrep"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

const rgDescription = `使用程序内嵌的原生 ripgrep (rg) 搜索项目。无需安装 rg、无需 PATH、运行时无需下载；对应系统/架构的预编译二进制由 //go:embed 捆绑，首次使用自动解压到用户缓存并校验 SHA-256。直接执行参数，不经过 shell，不加载用户 rg 配置。只读工具。
三种 mode：
content（默认）：pattern 必填，返回 文件名:行号:原始文本；context_lines=N 显示前后各 N 行，上下文用 - 分隔字段，不相邻段用 -- 分隔。
files：相当于 rg --files，仅列出符合 globs 的文件路径；不要提供 pattern。
files_with_matches：相当于 rg -l，pattern 必填，仅列出内容匹配的文件，每个文件一次。
默认采用区分大小写的 Rust/Unicode 正则，不支持环视和反向引用；perl_regexp=true 使用 PCRE2。fixed_strings=true 将 pattern 当作原样文本，不可与 perl_regexp 同用。ignore_case=true 忽略内容大小写，word_regexp=true 限制整词。pattern 不要添加 shell 引号；JSON 中反斜杠仍须写成 \\。不要使用 HTML 实体（&lt;、&gt;、&amp;）：它们会被当作字面文本，XML 标签应直接写 <version>。
path 默认为项目根，支持项目内相对路径及当前/本轮关联项目内的绝对路径；目录递归搜索，max_depth=1 只处理直接子项，0 不限深度。不跟随目录内部的符号链接或 junction，不读取设备/FIFO。
globs 如 ["*.go","!**/*_test.go","!**/vendor/**"]。使用 /，采用 rg 原生 gitignore 风格；不含 / 的模式匹配任意层级文件名，! 前缀排除，多个规则最后匹配者优先。正向 glob 可覆盖忽略/隐藏规则。支持 *、**、?、[...] 和 {go,ts} 扩展；逗号是花括号展开的分隔符，不是多个独立模式的分隔符。
默认跳过二进制、隐藏项，遵守 rg 原生 .gitignore/.ignore/.rgignore 及父目录/全局忽略规则（.gitignore 按 rg 的 Git 仓库检测生效）。hidden=true 包含隐藏项；no_ignore=true 禁用忽略规则；二者独立。files 模式列文件名时可以包含二进制文件。
max_results 默认 200、最大 1000，限制输出行数（含上下文/分隔符），输出最多 64 KiB；超限主动停止并返回 truncated=true，缩小 path/globs/pattern 后重试。timeout_ms 默认 60000、最大 120000，取消/超时会清理搜索进程树。
返回 result（文本）、matched、exit_code、truncated；stderr 非空时附诊断。正常退出码 0=有结果，1=无结果（不是失败），2=错误；truncated=true 时 exit_code 为主动终止产生的实际退出码，不代表搜索完整完成。
本工具不列目录项，但能列文件：枚举/统计源码文件用 files 模式，按内容筛文件用 files_with_matches；统计行数、出现次数等也优先用本工具，不要在 shell 里逐文件 Get-Content/Measure-Object 或 Select-String——那在大仓库中会慢到几十秒。只有查看目录结构时才用当前 shell 的 Get-ChildItem、dir、ls、find。旧 grep/ls/glob 工具已移除。
示例：
{"pattern":"func\\s+New","globs":["*.go"],"context_lines":2}
{"pattern":"a.b(","fixed_strings":true,"path":"internal"}
{"mode":"files","globs":["**/*controller*.go","!**/*_test.go"]}
{"mode":"files_with_matches","pattern":"TODO|FIXME","globs":["!**/vendor/**"]}
{"pattern":"(?<=func )\\w+","perl_regexp":true,"globs":["*.go"]}`

type rgInput struct {
	Pattern      string   `json:"pattern,omitempty" jsonschema:"content/files_with_matches 必填的内容正则或原样文本；files 模式不得提供；不要加 shell 引号"`
	Path         string   `json:"path,omitempty" jsonschema:"文件或目录，默认项目根；相对路径或当前/本轮关联项目内的绝对路径"`
	Mode         string   `json:"mode,omitempty" jsonschema:"选择模式：content 为内容和行号（默认）；files 为 rg --files；files_with_matches 为 rg -l；不提供目录列表"`
	Globs        []string `json:"globs,omitempty" jsonschema:"rg -g 文件过滤，如 [\"*.go\",\"!**/*_test.go\",\"!**/vendor/**\"]；使用 /；最后匹配的规则优先"`
	FixedStrings bool     `json:"fixed_strings,omitempty" jsonschema:"pattern 视为原样文本，对应 -F；不可与 perl_regexp 同用"`
	PerlRegexp   bool     `json:"perl_regexp,omitempty" jsonschema:"启用 PCRE2 正则如环视/反向引用，对应 -P"`
	IgnoreCase   bool     `json:"ignore_case,omitempty" jsonschema:"忽略内容的大小写，对应 -i；不影响路径 glob"`
	WordRegexp   bool     `json:"word_regexp,omitempty" jsonschema:"完整单词匹配，对应 -w"`
	ContextLines int      `json:"context_lines,omitempty" jsonschema:"前后各显示的上下文行数，0..20；仅 content 模式"`
	Hidden       bool     `json:"hidden,omitempty" jsonschema:"包含隐藏文件/目录；不会禁用 ignore 规则；默认 false"`
	NoIgnore     bool     `json:"no_ignore,omitempty" jsonschema:"禁用 rg 忽略规则（含父目录和全局规则）；不会自动包含隐藏项；默认 false"`
	MaxDepth     int      `json:"max_depth,omitempty" jsonschema:"递归深度，1 表示仅直接子项，0 表示不限深度"`
	MaxResults   int      `json:"max_results,omitempty" jsonschema:"最多输出行数，默认 200，1..1000；含上下文和分隔符"`
	TimeoutMs    int      `json:"timeout_ms,omitempty" jsonschema:"超时毫秒数，默认 60000，最大 120000"`
}

// ResolveName preserves saved grep and shell settings without exposing removed tools.
func ResolveName(name string) string {
	if name == "grep" {
		return "rg"
	}
	return shellenv.ToolName(name)
}

func rgTool(root string) tool.Tool {
	t, err := functiontool.New[rgInput, map[string]any](
		functiontool.Config{Name: "rg", Description: rgDescription},
		func(ctx agentpkg.Context, in rgInput) (map[string]any, error) {
			return runRG(ctx, root, in)
		})
	if err != nil {
		panic(fmt.Errorf("build rg tool: %w", err))
	}
	return t
}

func runRG(ctx context.Context, root string, in rgInput) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	args, err := rgArgs(in)
	if err != nil {
		return nil, err
	}
	path, err := contextualPath(ctx, root, in.Path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("path 必须是普通文件或目录")
	}
	workdir, err := fsutil.Resolve(root)
	if err != nil {
		return nil, err
	}
	operand := path
	if rel, err := filepath.Rel(workdir, path); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
		operand = "./" + filepath.ToSlash(rel)
	}
	args = append(args, "--", operand)
	binary, err := ripgrep.Executable()
	if err != nil {
		return nil, err
	}
	timeout := in.TimeoutMs
	if timeout == 0 {
		timeout = 60000
	}
	runCtx, cancelTimeout := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancelTimeout()
	runCtx, cancelOutput := context.WithCancel(runCtx)
	defer cancelOutput()
	limit := in.MaxResults
	if limit == 0 {
		limit = 200
	}
	stdout := &rgOutput{maxBytes: 64 * 1024, maxLines: limit, cancel: cancelOutput}
	stderr := &rgOutput{maxBytes: 8 * 1024}
	cmd := exec.CommandContext(runCtx, binary, args...)
	cmd.Dir = workdir
	cmd.Env = rgEnvironment()
	cmd.Stdout, cmd.Stderr = stdout, stderr
	tree, err := processtree.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("启动 rg 失败: %w", err)
	}
	defer tree.Kill()
	waitErr := cmd.Wait()
	if err := tree.Kill(); err != nil {
		return nil, fmt.Errorf("清理 rg 进程树失败: %w", err)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	exitCode := cmd.ProcessState.ExitCode()
	if !stdout.truncated && runCtx.Err() != nil {
		return nil, fmt.Errorf("rg 搜索超时或被取消: %w", runCtx.Err())
	}
	if !stdout.truncated && waitErr != nil && exitCode != 1 {
		return nil, fmt.Errorf("rg 执行失败（退出码 %d）: %s: %w", exitCode, stderr.String(), waitErr)
	}
	text := stdout.String()
	matched := exitCode == 0 || stdout.truncated
	if !matched {
		text = "(无匹配)"
	}
	if stdout.truncated {
		text += "\n[输出已截断；请缩小 path/globs/pattern 后重试]"
	}
	out := map[string]any{"result": text, "matched": matched, "exit_code": exitCode, "truncated": stdout.truncated}
	if stderr.buffer.Len() > 0 {
		out["stderr"] = stderr.String()
		out["stderr_truncated"] = stderr.truncated
	}
	return out, nil
}

func rgArgs(in rgInput) ([]string, error) {
	if in.Mode == "" {
		in.Mode = "content"
	}
	if in.Mode != "content" && in.Mode != "files" && in.Mode != "files_with_matches" {
		return nil, fmt.Errorf("mode 必须是 content、files 或 files_with_matches")
	}
	if in.Mode == "files" && in.Pattern != "" {
		return nil, fmt.Errorf("files 模式只列文件路径，不接受 pattern；按内容筛文件请用 files_with_matches")
	}
	if in.Mode != "files" && in.Pattern == "" {
		return nil, fmt.Errorf("content/files_with_matches 模式必须提供 pattern")
	}
	if in.Mode == "files" && (in.FixedStrings || in.PerlRegexp || in.IgnoreCase || in.WordRegexp) {
		return nil, fmt.Errorf("内容匹配选项不适用于 files 模式")
	}
	if in.FixedStrings && in.PerlRegexp {
		return nil, fmt.Errorf("fixed_strings 和 perl_regexp 不能同时启用")
	}
	if in.ContextLines < 0 || in.ContextLines > 20 || (in.Mode != "content" && in.ContextLines != 0) {
		return nil, fmt.Errorf("context_lines 仅用于 content，范围为 0..20")
	}
	if in.MaxDepth < 0 || in.MaxResults < 0 || in.MaxResults > 1000 || in.TimeoutMs < 0 || in.TimeoutMs > 120000 {
		return nil, fmt.Errorf("max_depth 不得为负；max_results 最大 1000；timeout_ms 最大 120000")
	}
	args := []string{"--no-config", "--no-follow", "--color=never", "--sort=path", "--line-buffered"}
	if in.NoIgnore {
		args = append(args, "--no-ignore")
	}
	if in.Hidden {
		args = append(args, "--hidden")
	}
	if in.FixedStrings {
		args = append(args, "--fixed-strings")
	}
	if in.PerlRegexp {
		args = append(args, "--pcre2")
	}
	if in.IgnoreCase {
		args = append(args, "--ignore-case")
	}
	if in.WordRegexp {
		args = append(args, "--word-regexp")
	}
	if in.ContextLines > 0 {
		args = append(args, "--context="+strconv.Itoa(in.ContextLines))
	}
	if in.MaxDepth > 0 {
		args = append(args, "--max-depth="+strconv.Itoa(in.MaxDepth))
	}
	for _, glob := range in.Globs {
		if glob == "" {
			return nil, fmt.Errorf("globs 不得包含空模式")
		}
		args = append(args, "--glob="+glob)
	}
	if in.Mode == "files" {
		return append(args, "--files"), nil
	}
	if in.Mode == "files_with_matches" {
		args = append(args, "--files-with-matches")
	} else {
		args = append(args, "--with-filename", "--line-number", "--no-heading")
	}
	return append(args, "--regexp="+in.Pattern), nil
}

func rgEnvironment() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		switch strings.ToUpper(key) {
		case "RIPGREP_CONFIG_PATH":
			continue
		}
		env = append(env, item)
	}
	return env
}

type rgOutput struct {
	buffer    bytes.Buffer
	maxBytes  int
	maxLines  int
	lines     int
	truncated bool
	cancel    context.CancelFunc
}

func (out *rgOutput) Write(data []byte) (int, error) {
	size := len(data)
	if out.truncated {
		return size, nil
	}
	keep := len(data)
	if remaining := out.maxBytes - out.buffer.Len(); keep > remaining {
		keep = remaining
	}
	for i, b := range data[:keep] {
		if out.maxLines > 0 && out.lines >= out.maxLines {
			keep = i
			break
		}
		if b == '\n' {
			out.lines++
		}
	}
	out.buffer.Write(data[:keep])
	if keep < size {
		out.truncated = true
		if out.cancel != nil {
			out.cancel()
		}
	}
	return size, nil
}

func (out *rgOutput) String() string {
	return strings.TrimRight(strings.ToValidUTF8(out.buffer.String(), "\ufffd"), "\r\n")
}

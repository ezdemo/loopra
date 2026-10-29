package git

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
)

type DiffContent struct {
	Diff string `json:"diff"`
	Stat string `json:"stat"`
}

// DiffContentAt 返回统一差异与统计。未跟踪文件会合成差异，单文件最多 2000 行。
func DiffContentAt(dir, path string) (DiffContent, error) {
	if strings.TrimSpace(path) != "" {
		clean, err := gitops.ValidatePath(dir, path)
		if err != nil {
			return DiffContent{}, fail(http.StatusBadRequest, "Invalid path")
		}
		path = clean
	}
	var diff, stat strings.Builder
	if !gitops.IsRepo(dir) {
		if path == "" {
			return DiffContent{}, nil
		}
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
		if err != nil {
			return DiffContent{}, nil
		}
		return DiffContent{
			Diff: string(data),
			Stat: fmt.Sprintf("%s | %d lines", path, contentLineCount(string(data))),
		}, nil
	}
	run := gitops.Runner{Dir: dir}
	var diffArgs, statArgs []string
	if path != "" {
		diffArgs = []string{"--", path}
		statArgs = diffArgs
	}
	if out, _, _ := run.Git(gitops.TimeoutQuery, append([]string{"diff"}, diffArgs...)...); out != "" {
		diff.WriteString(out)
	}
	if out, _, _ := run.Git(gitops.TimeoutQuery, append([]string{"diff", "--cached"}, diffArgs...)...); out != "" {
		if diff.Len() > 0 {
			diff.WriteString("\n")
		}
		diff.WriteString(out)
	}
	if out, _, _ := run.Git(gitops.TimeoutQuery, append([]string{"diff", "--stat"}, statArgs...)...); out != "" {
		stat.WriteString(out)
	}
	if out, _, _ := run.Git(gitops.TimeoutQuery, append([]string{"diff", "--cached", "--stat"}, statArgs...)...); out != "" {
		if stat.Len() > 0 {
			stat.WriteString("\n")
		}
		stat.WriteString(out)
	}
	if diff.Len() == 0 && path != "" {
		if gitops.IsUntracked(dir, path) {
			if data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path))); err == nil {
				lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
				if len(lines) > 2000 {
					lines = lines[:2000]
				}
				var sb strings.Builder
				fmt.Fprintf(&sb, "--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n", path, len(lines))
				for _, line := range lines {
					sb.WriteString("+" + line + "\n")
				}
				diff.WriteString(sb.String())
				stat.WriteString(fmt.Sprintf("%s | %d ++", path, len(lines)))
			}
		} else if data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path))); err == nil {
			diff.WriteString(string(data))
		}
	}
	out := diff.String()
	if path != "" {
		if lines := strings.Count(out, "\n"); lines > 2000 {
			truncated := strings.SplitN(out, "\n", 2001)[0]
			out = truncated + "\n\n... (差异过大，仅显示前 2000 行，请在终端查看完整 diff)"
		}
	}
	return DiffContent{Diff: out, Stat: stat.String()}, nil
}

// Show 读取某个 git 引用上的文件内容。
func Show(dir, path, ref string) (string, error) {
	if path == "" {
		return "", fail(http.StatusBadRequest, "path 参数必填")
	}
	if ref == "" {
		ref = "HEAD"
	}
	if !gitops.IsRepo(dir) {
		return "", fail(http.StatusBadRequest, "File not found: not a git repository")
	}
	clean, err := gitops.ValidatePath(dir, path)
	if err != nil {
		return "", fail(http.StatusBadRequest, err.Error())
	}
	out, stderr, err := gitops.Runner{Dir: dir}.Git(gitops.TimeoutQuery, "show", ref+":"+clean)
	if err != nil {
		return "", fail(http.StatusBadRequest, "File not found: "+stderr)
	}
	return out, nil
}

type WorkingFile struct {
	Content string `json:"content,omitempty"`
	Exists  bool   `json:"exists"`
	Message string `json:"message,omitempty"`
}

const previewLimit = 1 << 20

// WorkingFileAt 读取工作区文件。编辑器追加的 :行号 会被去掉。
func WorkingFileAt(dir, path string) (WorkingFile, error) {
	if path == "" {
		return WorkingFile{}, fail(http.StatusBadRequest, "path 参数必填")
	}
	if i := strings.LastIndex(path, ":"); i > 0 {
		if _, err := strconv.Atoi(path[i+1:]); err == nil {
			path = path[:i]
		}
	}
	clean, err := gitops.ValidatePath(dir, path)
	if err != nil {
		return WorkingFile{}, fail(http.StatusBadRequest, "Invalid path")
	}
	full := filepath.Join(dir, filepath.FromSlash(clean))
	info, err := os.Stat(full)
	if err != nil || !info.Mode().IsRegular() {
		return WorkingFile{Exists: false, Message: "当前项目中未找到此文件，可能已移动或删除。"}, nil
	}
	if info.Size() > previewLimit {
		return WorkingFile{Exists: true, Message: "文件过大，无法预览（最大 1 MB）。"}, nil
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return WorkingFile{Exists: false, Message: "当前项目中未找到此文件，可能已移动或删除。"}, nil
	}
	return WorkingFile{Content: string(data), Exists: true}, nil
}

// CommitFiles 收集要生成提交说明的路径。请求未指定时使用当前变更。
func CommitFiles(dir string, requested []string) ([]string, error) {
	if !gitops.IsRepo(dir) {
		return nil, fail(http.StatusBadRequest, "Not a git repository")
	}
	var files []string
	for _, file := range requested {
		if path, err := gitops.ValidatePath(dir, file); err == nil {
			files = append(files, path)
		}
	}
	if len(files) == 0 {
		view := gitops.StatusAt(dir)
		for _, changed := range view.Changed {
			files = append(files, changed.Path)
		}
		for _, untracked := range view.Untracked {
			files = append(files, untracked.Path)
		}
	}
	if len(files) == 0 {
		return nil, fail(http.StatusBadRequest, "没有待提交的变更")
	}
	return files, nil
}

// CommitPrompt 拼出提交说明提示词，附带最近提交和至多 3 个文件的差异。
func CommitPrompt(dir string, files []string) string {
	var prompt strings.Builder
	prompt.WriteString("根据以下项目变更生成 Git 提交消息。遵循最近提交的语言和风格。只输出提交消息，不加解释或代码块。\n变更文件：\n")
	for _, path := range files {
		prompt.WriteString(path + "\n")
	}
	prompt.WriteString("\n最近提交：\n" + strings.Join(gitops.RecentOneline(dir, 3), "\n"))
	run := gitops.Runner{Dir: dir}
	for i, path := range files {
		if i >= 3 {
			break
		}
		diff, _, _ := run.Git(gitops.TimeoutQuery, "diff", "HEAD", "--", path)
		if diff == "" {
			diff, _, _ = run.Git(gitops.TimeoutQuery, "diff", "--", path)
		}
		if diff == "" && gitops.IsUntracked(dir, path) {
			if data, err := os.ReadFile(filepath.Join(dir, path)); err == nil {
				diff = string(data)
			}
		}
		if len(diff) > 12000 {
			diff = diff[:12000]
		}
		prompt.WriteString("\n" + path + ":\n" + diff)
	}
	return prompt.String()
}

func contentLineCount(content string) int {
	if content == "" {
		return 0
	}
	return strings.Count(strings.TrimSuffix(content, "\n"), "\n") + 1
}

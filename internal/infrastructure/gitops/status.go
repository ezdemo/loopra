package gitops

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// FileChange 对应 GitFileChangeDTO：包含两个 porcelain 状态字符以及
// 派生的单字符状态（"M"、"A"、"D" 等）。
type FileChange struct {
	Path     string `json:"path"`
	Index    string `json:"index"`
	WorkTree string `json:"workTree"`
	Status   string `json:"status"`
}

// StatusView 汇总对某个目录的一次状态查询结果。
type StatusView struct {
	GitAvailable bool
	Initialized  bool
	Branch       string
	Changed      []FileChange
	Untracked    []FileChange
	Ahead        int
	Behind       int
	Upstream     string // 无上游时为 ""
}

// StatusAt 执行 Java getStatusAt 的流程：--version、工作树检查、
// 当前分支、porcelain -z 解析、ahead/behind 与上游分支。
func StatusAt(dir string) StatusView {
	view := StatusView{Changed: []FileChange{}, Untracked: []FileChange{}}
	r := Runner{Dir: dir}
	if _, _, err := r.Git(TimeoutQuery, "--version"); err != nil {
		return view
	}
	view.GitAvailable = true
	if _, _, err := r.Git(TimeoutQuery, "rev-parse", "--is-inside-work-tree"); err != nil {
		return view
	}
	view.Initialized = true
	if branch, err := r.Line(TimeoutQuery, "branch", "--show-current"); err == nil {
		view.Branch = branch
		if view.Branch == "" {
			view.Branch = "master"
		}
	}
	prefix := ""
	if out, err := r.Line(TimeoutQuery, "rev-parse", "--show-prefix"); err == nil {
		prefix = toSlash(out)
	}
	if out, _, err := r.Git(TimeoutQuery, "status", "--porcelain=v1", "-z",
		"--untracked-files=all", "--", "."); err == nil {
		view.Changed, view.Untracked = ParsePorcelainZ(out, prefix)
	}
	if out, _, err := r.Git(TimeoutQuery, "rev-list", "--left-right", "--count",
		"HEAD...@{upstream}"); err == nil {
		if fields := strings.Fields(out); len(fields) == 2 {
			view.Ahead, _ = strconv.Atoi(fields[0])
			view.Behind, _ = strconv.Atoi(fields[1])
		}
	}
	if out, err := r.Line(TimeoutQuery, "rev-parse", "--abbrev-ref",
		"--symbolic-full-name", "@{upstream}"); err == nil {
		view.Upstream = out
	}
	return view
}

// ParsePorcelainZ 拆分以 NUL 结尾的 porcelain v1 记录，跳过重命名/
// 复制后紧跟的原路径记录，并去掉 show-prefix 前缀。未跟踪文件与
// 已跟踪改动一样返回完整的 FileChange（"??" + Status "U"），
// 与 Java GitService.parsePorcelainStatus 的 DTO 形状保持一致。
func ParsePorcelainZ(out, prefix string) (changed []FileChange, untracked []FileChange) {
	changed = []FileChange{}
	untracked = []FileChange{}
	trimmed := strings.TrimRight(out, "\x00")
	if trimmed == "" {
		return changed, untracked
	}
	parts := strings.Split(trimmed, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 4 {
			continue
		}
		index := entry[:1]
		work := entry[1:2]
		path := toSlash(entry[3:])
		if index == "R" || index == "C" || work == "R" || work == "C" {
			i++ // 下一条 NUL 记录保存原路径
		}
		rel := stripPrefix(path, prefix)
		if rel == "" {
			continue
		}
		if index == "?" && work == "?" {
			untracked = append(untracked, FileChange{Path: rel, Index: index, WorkTree: work, Status: "U"})
			continue
		}
		status := index
		if status == " " || status == "?" {
			status = work
		}
		changed = append(changed, FileChange{Path: rel, Index: index, WorkTree: work, Status: status})
	}
	return changed, untracked
}

// stripPrefix 将路径转换为相对仓库内项目根目录的路径。
func stripPrefix(path, prefix string) string {
	if prefix == "" {
		return path
	}
	if strings.HasPrefix(path, prefix) {
		return strings.TrimPrefix(path, prefix)
	}
	return ""
}

// Dirty 报告目录是否存在工作树改动。
func Dirty(dir string) bool {
	out, _, err := Runner{Dir: dir}.Git(TimeoutQuery, "status", "--porcelain")
	return err == nil && strings.TrimSpace(out) != ""
}

// ValidatePath 对应 GitService.validatePath：拒绝绝对路径与
// 越出根目录的路径，输出使用斜杠分隔。
func ValidatePath(root, rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", fmt.Errorf("路径不能为空")
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("仅允许项目内相对路径: %s", rel)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(filepath.Join(absRoot, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if abs != absRoot && !strings.HasPrefix(abs, absRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("路径越出项目边界: %s", rel)
	}
	return toSlash(rel), nil
}

func toSlash(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ReplaceAll(p, "\\", "/")
	}
	return p
}

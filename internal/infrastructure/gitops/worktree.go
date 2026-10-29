package gitops

import (
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

// WorktreeBase 是会话工作树的父目录（~/.loopra/worktree）。
func WorktreeBase(home string) string {
	return filepath.Join(home, "worktree")
}

// Sanitize 保留 unicode 字母、数字与 "_-.[]"，其余字符替换为
// '_'，并限制在 80 个字符以内（对应 Java WorktreeService.sanitize）。
func Sanitize(name string) string {
	var sb strings.Builder
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) ||
			r == '_' || r == '-' || r == '.' || r == '[' || r == ']':
			sb.WriteRune(r)
		default:
			sb.WriteRune('_')
		}
	}
	out := []rune(sb.String())
	if len(out) > 80 {
		out = out[:80]
	}
	return string(out)
}

// WorktreePath 构造 <base>/<sanitize(wsHash)>-<sanitize(session)>。
func WorktreePath(base, wsHash, session string) string {
	return filepath.Join(base, Sanitize(wsHash)+"-"+Sanitize(session))
}

// SandboxBranch 构造 loopra/sandbox-<hash[:8]>-<sanitize(session)>。
func SandboxBranch(wsHash, session string) string {
	h := wsHash
	if len(h) > 8 {
		h = h[:8]
	}
	return "loopra/sandbox-" + h + "-" + Sanitize(session)
}

// ListWorktrees 返回已注册的工作树路径。
func ListWorktrees(dir string) ([]string, error) {
	out, _, err := Runner{Dir: dir}.Git(TimeoutQuery, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "worktree ") {
			paths = append(paths, strings.TrimSpace(strings.TrimPrefix(line, "worktree ")))
		}
	}
	return paths, nil
}

// IsRegisteredWorktree 同时检查目录是否存在以及是否已注册
// （Windows 上路径比较不区分大小写）。
func IsRegisteredWorktree(projectDir, candidate string) bool {
	paths, err := ListWorktrees(projectDir)
	if err != nil {
		return false
	}
	for _, p := range paths {
		if SamePath(p, candidate) {
			return true
		}
	}
	return false
}

// SamePath 以宽容方式比较两个文件系统路径。
func SamePath(a, b string) bool {
	a, _ = filepath.Abs(a)
	b, _ = filepath.Abs(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// CreateWorktree 添加沙箱工作树；分支已存在时直接复用，
// 否则从 HEAD 新建分支。
func CreateWorktree(projectDir, targetPath, branch string) error {
	r := Runner{Dir: projectDir}
	if out, err := r.Line(TimeoutWorktree, "branch", "--list", branch); err == nil && out != "" {
		_, _, err = r.Git(TimeoutWorktree, "worktree", "add", targetPath, branch)
		return err
	}
	_, _, err := r.Git(TimeoutWorktree, "worktree", "add", targetPath, "-b", branch, "HEAD")
	return err
}

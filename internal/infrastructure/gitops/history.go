package gitops

import (
	"fmt"
	"strings"
)

// CommitInfo 对应一条 GitCommitDTO 记录（以 0x1F 分隔的 log 格式）。
type CommitInfo struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Author    string `json:"author"`
	Email     string `json:"email"`
	Date      string `json:"date"`
	Message   string `json:"message"`
}

// LogAt 按 git 原生顺序返回历史记录；limit 默认为 50，
// 与 getCommitHistoryAt 一样限制在 [1,100] 区间。
func LogAt(dir string, limit int) []CommitInfo {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	r := Runner{Dir: dir}
	out, _, err := r.Git(TimeoutQuery, "log", fmt.Sprintf("-%d", limit),
		"--format=%H%x1F%h%x1F%an%x1F%ae%x1F%ai%x1F%s")
	if err != nil {
		return []CommitInfo{}
	}
	commits := []CommitInfo{}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x1f")
		if len(f) != 6 {
			continue
		}
		commits = append(commits, CommitInfo{
			Hash: f[0], ShortHash: f[1], Author: f[2], Email: f[3], Date: f[4], Message: f[5],
		})
	}
	return commits
}

// CurrentBranch 返回 rev-parse --abbrev-ref HEAD 的结果；
// 分离头指针时返回字面量 "HEAD"。
func CurrentBranch(dir string) (string, error) {
	return Runner{Dir: dir}.Line(TimeoutQuery, "rev-parse", "--abbrev-ref", "HEAD")
}

// RecentOneline 返回最近 n 条单行提交（用作风格参考）。
func RecentOneline(dir string, n int) []string {
	out, _, err := Runner{Dir: dir}.Git(TimeoutQuery, "log", "--oneline", fmt.Sprintf("-%d", n))
	if err != nil {
		return nil
	}
	var lines []string
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// FileDiffAt 拼接单个文件的已暂存与未暂存差异。
func FileDiffAt(dir, path string) string {
	r := Runner{Dir: dir}
	staged, _, _ := r.Git(TimeoutQuery, "diff", "--cached", "--", path)
	unstaged, _, _ := r.Git(TimeoutQuery, "diff", "--", path)
	if staged != "" && unstaged != "" {
		return staged + "\n" + unstaged
	}
	return staged + unstaged
}

// IsUntracked 报告某个路径的 "??" porcelain 状态。
func IsUntracked(dir, path string) bool {
	out, _, err := Runner{Dir: dir}.Git(TimeoutQuery, "status", "--porcelain", "--", path)
	return err == nil && strings.HasPrefix(strings.TrimSpace(out), "??")
}

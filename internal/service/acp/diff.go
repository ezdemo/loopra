package acp

import (
	"fmt"
	"strings"
)

// FileChange 是外部 Agent 报告的一次文件修改，字段与 Loopra
// 的 file_changes 事件一致。
type FileChange struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Created   bool   `json:"created"`
	Diff      string `json:"diff"`
}

// diffLineLimit 限制 LCS 的行数规模，超出时退化为整体替换统计，
// 避免大文件在对话线程里做平方级比较。
const diffLineLimit = 4000

// CompareFile 比较同一文件的修改前后文本，产出 Loopra 的变更视图。
func CompareFile(path string, oldText *string, newText string) FileChange {
	before := ""
	if oldText != nil {
		before = *oldText
	}
	change := FileChange{Path: path, Created: oldText == nil}
	oldLines := splitLines(before)
	newLines := splitLines(newText)
	if len(oldLines) > diffLineLimit || len(newLines) > diffLineLimit {
		change.Additions = countNew(oldLines, newLines)
		change.Deletions = countNew(newLines, oldLines)
		change.Diff = wholeFileDiff(path, before, newText)
		return change
	}
	ops := lineDiff(oldLines, newLines)
	var diff strings.Builder
	fmt.Fprintf(&diff, "--- a/%s\n+++ b/%s\n", path, path)
	for _, op := range ops {
		switch op.kind {
		case ' ':
			diff.WriteString(" " + op.text + "\n")
		case '-':
			change.Deletions++
			diff.WriteString("-" + op.text + "\n")
		case '+':
			change.Additions++
			diff.WriteString("+" + op.text + "\n")
		}
	}
	change.Diff = diff.String()
	return change
}

type diffOp struct {
	kind byte
	text string
}

// lineDiff 用 LCS 计算逐行差异；相同的行输出为上下文。
func lineDiff(oldLines, newLines []string) []diffOp {
	n, m := len(oldLines), len(newLines)
	table := make([][]int32, n+1)
	for i := range table {
		table[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else if table[i+1][j] >= table[i][j+1] {
				table[i][j] = table[i+1][j]
			} else {
				table[i][j] = table[i][j+1]
			}
		}
	}
	ops := make([]diffOp, 0, n+m)
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case oldLines[i] == newLines[j]:
			ops = append(ops, diffOp{' ', oldLines[i]})
			i++
			j++
		case table[i+1][j] >= table[i][j+1]:
			ops = append(ops, diffOp{'-', oldLines[i]})
			i++
		default:
			ops = append(ops, diffOp{'+', newLines[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, diffOp{'-', oldLines[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, diffOp{'+', newLines[j]})
	}
	return ops
}

func wholeFileDiff(path, before, after string) string {
	var diff strings.Builder
	fmt.Fprintf(&diff, "--- a/%s\n+++ b/%s\n", path, path)
	for _, line := range splitLines(before) {
		diff.WriteString("-" + line + "\n")
	}
	for _, line := range splitLines(after) {
		diff.WriteString("+" + line + "\n")
	}
	return diff.String()
}

func countNew(oldLines, newLines []string) int {
	set := make(map[string]struct{}, len(oldLines))
	for _, line := range oldLines {
		set[line] = struct{}{}
	}
	count := 0
	for _, line := range newLines {
		if _, ok := set[line]; !ok {
			count++
		}
	}
	return count
}

func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.TrimSuffix(text, "\n")
	if text == "" {
		return []string{""}
	}
	return strings.Split(text, "\n")
}

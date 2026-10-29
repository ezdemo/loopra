// shell.go 移植审批链使用的 Loopra shell 分类逻辑：
// 只读命令识别与工作区本地命令检查。
package hitl

import (
	"path/filepath"
	"strings"
)

// 只读 git 子命令及其允许的选项前缀。
var gitQuerySubcommands = map[string]bool{
	"status": true, "diff": true, "log": true, "show": true,
	"ls-files": true, "ls-tree": true,
}

// queryExecutables 自身从不改变状态。
var queryExecutables = map[string]bool{
	"pwd": true, "ls": true, "dir": true, "cat": true, "head": true,
	"tail": true, "wc": true, "rg": true, "grep": true, "find": true,
	"git": true,
}

// workspaceMutateExecutables 调用外部写入命令，当其路径目标
// 保持本地时也为本地（Java WorkspaceShellCommands 白名单，
// 包含 PowerShell cmdlets）。
var workspaceMutateExecutables = map[string]bool{
	"mkdir": true, "touch": true, "cp": true, "mv": true, "copy": true,
	"move": true, "echo": true, "printf": true,
	"set-content": true, "add-content": true, "new-item": true,
	"copy-item": true, "move-item": true,
}

// mutateOptionWhitelist 限定可变执行命令允许的选项
// （Java WorkspaceShellCommands）。
var mutateOptionWhitelist = map[string]bool{
	"-p": true, "-r": true, "-R": true, "-f": true, "-n": true, "-v": true,
	"--parents": true, "--recursive": true, "--force": true,
	"--no-clobber": true, "--verbose": true,
}

// hardMetachars 直接中止分类：任何包含这些字符的命令
// 都无法证明是只读或本地的（与注入相邻）。">"、"&&" 与
// "||" 则按分隔符/重定向处理。
const hardMetachars = "$`&<^%!()\r\n\x00{}"

// splitShell 按分隔符（";"、"|"、"&&"、"||"、换行）将命令切成
// 多个片段；只有每个片段都满足同一判定，整条命令
// 才成立。
func splitShell(command string) []string {
	var segments []string
	var current strings.Builder
	quote := byte(0)
	flush := func() {
		segments = append(segments, current.String())
		current.Reset()
	}
	for i := 0; i < len(command); i++ {
		c := command[i]
		next := byte(0)
		if i+1 < len(command) {
			next = command[i+1]
		}
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
			current.WriteByte(c)
		case c == '\'' || c == '"':
			quote = c
			current.WriteByte(c)
		case c == ';':
			flush()
		case c == '\n':
			flush()
		case c == '|' && next == '|':
			flush()
			i++
		case c == '&' && next == '&':
			flush()
			i++
		case c == '|' || c == '&':
			// 单个管道/与符：不是可识别的分隔符
			current.WriteByte(c)
		default:
			current.WriteByte(c)
		}
	}
	flush()
	return segments
}

// segmentTokens 对一个片段做分词，拒绝分类器
// 无法推理的元字符（返回 nil 表示无法分类）。
func segmentTokens(seg string) []string {
	if strings.ContainsAny(seg, hardMetachars) {
		return nil
	}
	fields := strings.Fields(seg)
	return fields
}

// redirectsLocal 报告 token 列表中每个重定向目标（>、>>）
// 是否都停留在工作树内。
func redirectsLocal(fields []string) bool {
	redirect := false
	for _, f := range fields {
		if redirect {
			if isAbsPath(f) || strings.HasPrefix(f, "..") || strings.HasPrefix(f, "~") {
				return false
			}
			redirect = false
			continue
		}
		if f == ">" || f == ">>" {
			redirect = true
			continue
		}
		if strings.HasPrefix(f, ">") { // ">file" 粘连形式
			target := strings.TrimLeft(f, ">")
			if isAbsPath(target) || strings.HasPrefix(target, "..") || strings.HasPrefix(target, "~") {
				return false
			}
		}
	}
	return !redirect // 悬空重定向属格式错误：拒绝
}

// isReadOnlyShell 报告命令的每个片段是否都是已知的
// 只读查询（git 查询子命令、搜索/列表工具）且仅带普通
// 选项。重定向会写入，因此任何重定向都判为不合格。
func isReadOnlyShell(command string) bool {
	for _, seg := range splitShell(command) {
		fields := segmentTokens(seg)
		if len(fields) == 0 {
			return false
		}
		if strings.Contains(seg, ">") {
			return false
		}
		// 通配符与转义会让查询白名单的效果不可预测
		//（Java ReadOnlyShellCommands 分词器）。
		if strings.ContainsAny(seg, "*?[\\") {
			return false
		}
		head := strings.ToLower(filepath.Base(fields[0]))
		if head == "git" {
			if len(fields) < 2 || !gitQuerySubcommands[fields[1]] {
				return false
			}
			continue
		}
		if !queryExecutables[head] {
			return false
		}
		for _, f := range fields[1:] {
			// find -exec 会执行命令：绝不只读。
			if f == "-exec" || f == "--exec" || strings.HasPrefix(f, "-exec") {
				return false
			}
		}
	}
	return true
}

// isWorkspaceLocalShell 报告影响停留在工作树内的命令：
// 只读查询，以及使用相对路径目标和本地重定向的
// 本地文件变更。
func isWorkspaceLocalShell(command string) bool {
	for _, seg := range splitShell(command) {
		fields := segmentTokens(seg)
		if len(fields) == 0 {
			return false
		}
		if !redirectsLocal(fields) {
			return false
		}
		head := strings.ToLower(filepath.Base(fields[0]))
		if head == "git" || queryExecutables[head] {
			if !isReadOnlyShell(seg) {
				return false
			}
			continue
		}
		if !workspaceMutateExecutables[head] {
			return false
		}
		// 选项受限于 Java 白名单；位置参数路径必须
		// 保持相对（工作区内）。echo/printf 接受自由文本。
		freeText := head == "echo" || head == "printf" ||
			head == "set-content" || head == "add-content"
		for _, f := range fields[1:] {
			if strings.HasPrefix(f, ">") {
				continue
			}
			if strings.HasPrefix(f, "-") {
				if !freeText && !mutateOptionWhitelist[f] {
					return false
				}
				continue
			}
			if isAbsPath(f) || strings.HasPrefix(f, "..") || strings.HasPrefix(f, "~") {
				return false
			}
		}
	}
	return true
}

// withinRoot 报告 rel 是否停留在 root 内（词法检查；
// 工具在执行时用真实路径再次校验）。
func withinRoot(root, rel string) bool {
	if rel == "" {
		return true
	}
	if isAbsPath(rel) {
		return false
	}
	clean := filepath.Clean(rel)
	if isAbsPath(clean) {
		return false
	}
	return clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

// isAbsPath 同时接受操作系统原生与 POSIX 风格的绝对路径，
// 使分类器在 Windows 与 Unix 上行为一致。
func isAbsPath(p string) bool {
	return filepath.IsAbs(p) || strings.HasPrefix(p, "/")
}

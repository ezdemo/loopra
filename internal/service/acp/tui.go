package acp

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// TUIStart 描述这次启动是 TUI 会话的首次还是再次拉起。
type TUIStart struct {
	// Resume 为 true 表示该会话的 CLI 之前已经跑过：按各家约定续接。
	Resume bool
	// ResumeID 只有 claude-code 使用：创建会话时生成的 UUID。
	ResumeID string
}

// TUILaunch 组装外部 Agent 交互式 CLI 的启动命令：直接跑各家 TUI，
// 而不是 ACP 适配器。
func TUILaunch(agentID string, start TUIStart) (Launch, error) {
	switch agentID {
	case "claude-code":
		return claudeTUILaunch(start)
	case "codex":
		return codexTUILaunch(start)
	case "devin":
		return devinTUILaunch(start)
	}
	return Launch{}, fmt.Errorf("未知的外部 Agent: %s", agentID)
}

// tuiArgs 是各 CLI 的启动参数：首次拉起开新会话，再次拉起续接。
// 注意 codex/devin 只能续「当前目录最近一次」CLI 会话：同一项目里
// 存在多个 TUI 会话时，重开可能接到错误的那条上；claude-code 用
// 持久化的 UUID 精确定位，没有这个问题。
func tuiArgs(agentID string, start TUIStart) []string {
	switch agentID {
	case "claude-code":
		if start.Resume && start.ResumeID != "" {
			return []string{"--resume", start.ResumeID}
		}
		if start.ResumeID != "" {
			return []string{"--session-id", start.ResumeID}
		}
		return nil
	case "codex":
		if start.Resume {
			return []string{"resume", "--last"}
		}
		return nil
	case "devin":
		if start.Resume {
			return []string{"-c"}
		}
		return nil
	}
	return nil
}

// cliCommand 按平台组装 CLI 调用：Windows 的 .cmd/.bat 垫片不能由
// ConPTY 直接执行，必须经 cmd.exe；.ps1 垫片不支持。
func cliCommand(path string, args ...string) ([]string, error) {
	return cliCommandFor(runtime.GOOS, path, args...)
}

func cliCommandFor(goos, path string, args ...string) ([]string, error) {
	if goos == "windows" {
		switch strings.ToLower(filepath.Ext(path)) {
		case ".cmd", ".bat":
			shell := envValue("COMSPEC")
			if shell == "" {
				shell = "cmd.exe"
			}
			return append([]string{shell, "/c", path}, args...), nil
		case ".ps1":
			return nil, fmt.Errorf("不支持 PowerShell 垫片: %s", path)
		}
	}
	return append([]string{path}, args...), nil
}

// cliLaunch 给脚本入口补 node 前缀，再按平台包装。
func cliLaunch(cli, node string, args ...string) (Launch, error) {
	var command []string
	var err error
	if isScript(cli) {
		if node == "" {
			return Launch{}, fmt.Errorf("后端未找到 Node.js，请检查后端进程的 Path 或 NVM_SYMLINK")
		}
		command, err = cliCommand(node, append([]string{cli}, args...)...)
	} else {
		command, err = cliCommand(cli, args...)
	}
	if err != nil {
		return Launch{}, err
	}
	return Launch{Command: command, Env: map[string]string{"PATH": prependPath(node, cli)}}, nil
}

// findCodex 定位 Codex CLI（独立于 ACP 适配器）。
func findCodex(roots []string) string {
	if override := envValue("LOOPRA_CODEX_EXECUTABLE"); override != "" {
		return executable(override)
	}
	names := []string{"codex"}
	if windows() {
		names = []string{"codex.exe", "codex.cmd", "codex.bat"}
	}
	for _, root := range roots {
		for _, name := range names {
			if found := executable(filepath.Join(root, name)); found != "" {
				return found
			}
		}
	}
	return ""
}

func claudeTUILaunch(start TUIStart) (Launch, error) {
	roots := searchRoots()
	node := findNode(roots)
	roots = withNodeRoots(roots, node)
	cli := findClaude(roots)
	if cli == "" {
		return Launch{}, fmt.Errorf("后端未找到 Claude Code，可用 CLAUDE_CODE_EXECUTABLE 指定路径")
	}
	return cliLaunch(cli, node, tuiArgs("claude-code", start)...)
}

func codexTUILaunch(start TUIStart) (Launch, error) {
	roots := searchRoots()
	node := findNode(roots)
	roots = withNodeRoots(roots, node)
	cli := findCodex(roots)
	if cli == "" {
		return Launch{}, fmt.Errorf("后端未找到 Codex CLI，请安装 codex 或用 LOOPRA_CODEX_EXECUTABLE 指定路径")
	}
	return cliLaunch(cli, node, tuiArgs("codex", start)...)
}

func devinTUILaunch(start TUIStart) (Launch, error) {
	cli := findDevin(searchRoots())
	if cli == "" {
		return Launch{}, fmt.Errorf("后端未找到 Devin CLI，请安装 devin 或用 LOOPRA_DEVIN_EXECUTABLE 指定路径")
	}
	return cliLaunch(cli, "", tuiArgs("devin", start)...)
}

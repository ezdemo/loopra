package acp

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const solonCodeNotFound = "后端未找到 SolonCode CLI，请安装 SolonCode 或用 LOOPRA_SOLONCODE_EXECUTABLE 指定路径"

func findSolonCode(roots []string) string {
	if override := envValue("LOOPRA_SOLONCODE_EXECUTABLE"); override != "" {
		if windows() {
			switch strings.ToLower(filepath.Ext(override)) {
			case ".exe", ".cmd", ".bat":
			default:
				return ""
			}
		} else if isScript(override) {
			return ""
		}
		return executable(override)
	}
	names := []string{"soloncode"}
	if windows() {
		names = []string{"soloncode.exe", "soloncode.cmd", "soloncode.bat"}
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".soloncode", "bin"))
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

func detectSolonCode() Availability {
	if findSolonCode(searchRoots()) == "" {
		return Availability{Detail: solonCodeNotFound}
	}
	return Availability{Available: true, Detail: "使用本机 SolonCode 模型配置"}
}

func prepareSolonCode(_ string) (Launch, error) {
	cli := findSolonCode(searchRoots())
	if cli == "" {
		return Launch{}, fmt.Errorf("SolonCode ACP 不可用: %s", solonCodeNotFound)
	}
	launch := Launch{Command: []string{cli, "acp"}, Env: map[string]string{"PATH": prependPath(cli)}}
	if windows() {
		switch strings.ToLower(filepath.Ext(cli)) {
		case ".bat", ".cmd":
			shell := envValue("COMSPEC")
			if shell == "" {
				shell = "cmd.exe"
			}
			// Expand the quoted path once in cmd.exe, without reparsing it as command-line arguments.
			launch.Env["LOOPRA_SOLONCODE_BATCH"] = `"` + cli + `"`
			launch.Command = []string{shell, "/d", "/v:off", "/c", "%LOOPRA_SOLONCODE_BATCH%", "acp"}
		}
	}
	return launch, nil
}

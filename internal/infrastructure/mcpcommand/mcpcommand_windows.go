//go:build windows

package mcpcommand

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func command(name string, args []string) *exec.Cmd {
	path, err := exec.LookPath(name)
	if err != nil {
		return exec.Command(name, args...)
	}
	lower := strings.ToLower(path)
	if ext := filepath.Ext(lower); (ext != ".cmd" && ext != ".bat") || filepath.Base(lower) != "npx"+ext {
		return exec.Command(path, args...)
	}
	dir := filepath.Dir(path)
	cli := filepath.Join(dir, "node_modules", "npm", "bin", "npx-cli.js")
	if !regularFile(cli) {
		cmd := exec.Command(path, args...)
		cmd.Err = fmt.Errorf("无法安全启动 npx：%s 旁未找到 %s，请检查 Node.js/npm 安装", path, cli)
		return cmd
	}
	node := filepath.Join(dir, "node.exe")
	if !regularFile(node) {
		resolved, err := exec.LookPath("node")
		if err != nil {
			cmd := exec.Command(path, args...)
			cmd.Err = fmt.Errorf("无法安全启动 npx：未找到 node.exe")
			return cmd
		}
		node = resolved
	}
	return exec.Command(node, append([]string{cli}, args...)...)
}

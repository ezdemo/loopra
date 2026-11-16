//go:build !windows

package mcpcommand

import "os/exec"

func command(name string, args []string) *exec.Cmd {
	return exec.Command(name, args...)
}

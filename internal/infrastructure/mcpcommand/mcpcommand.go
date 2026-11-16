package mcpcommand

import "os/exec"

func Command(name string, args ...string) *exec.Cmd {
	return command(name, args)
}

//go:build !windows

package hideconsole

import "os/exec"

func Apply(cmd *exec.Cmd) {}

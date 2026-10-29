//go:build unix

package processtree

import (
	"os/exec"
	"strconv"
	"strings"
)

func processRunning(pid int) bool {
	// Zombies have terminated but may await reaping by the host's init process.
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	state := strings.TrimSpace(string(out))
	return err == nil && state != "" && !strings.HasPrefix(state, "Z")
}

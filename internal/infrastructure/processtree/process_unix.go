//go:build unix

package processtree

import (
	"errors"
	"os/exec"
	"syscall"
)

// Start gives each command its own process group, including background children.
func Start(cmd *exec.Cmd) (*Tree, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	tree := &Tree{}
	tree.mu.Lock()
	defer tree.mu.Unlock()
	if cmd.Cancel != nil {
		cmd.Cancel = tree.Kill
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pgid := cmd.Process.Pid
	tree.kill = func() error {
		err := syscall.Kill(-pgid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	return tree, nil
}

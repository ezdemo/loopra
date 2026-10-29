//go:build windows

package hideconsole

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// Apply 让 Windows 不要为这个子进程分配控制台。
// 桌面端拉起 git、PowerShell、Node 时，否则会各闪出一个命令窗口。
func Apply(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}

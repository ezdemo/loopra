//go:build windows

package logging

import (
	"os"

	"golang.org/x/sys/windows"
)

// enableVirtualTerminal 打开 Windows 控制台的 ANSI 解析。
// 不打开时，彩色转义序列会被原样打印或直接丢掉。
func enableVirtualTerminal() {
	handle := windows.Handle(os.Stdout.Fd())
	var mode uint32
	if err := windows.GetConsoleMode(handle, &mode); err != nil {
		return
	}
	_ = windows.SetConsoleMode(handle, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
}

package desktop

import (
	"errors"

	"github.com/egoist/mygo"
)

func checkTray(tray *mygo.Tray) error {
	// mygo 的 NewTray 不检查 Shell_NotifyIconW 的注册结果。
	// Bounds 会完成延迟注册，并向 Explorer 查询实际存在的图标。
	bounds := tray.Bounds()
	if bounds.Width <= 0 || bounds.Height <= 0 {
		return errors.New("Windows notification area did not register the Loopra icon")
	}
	return nil
}

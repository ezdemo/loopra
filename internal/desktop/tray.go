package desktop

import (
	"fmt"

	"github.com/egoist/mygo"

	"github.com/ezdemo/looprax/internal/appicon"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// KeepInTray 在主线程、应用就绪后调用。只有托盘创建成功才拦截关闭，
// 以免缺少托盘支持的系统把唯一的窗口隐藏后无法恢复。
func KeepInTray(win *mygo.Window) error {
	resident := &residentWindow{window: win}
	mygo.App.OnActivate(func(bool) {
		if !win.IsVisible() || win.IsMinimized() {
			resident.open()
		}
	})
	mygo.App.OnSecondInstance(func([]string, string) { resident.open() })

	openLabel, quitLabel := "打开 Loopra", "退出"
	if mygo.App.Locale() == "en" {
		openLabel, quitLabel = "Open Loopra", "Quit"
	}
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:      "loopra.workspace",
		Icon:    appicon.PNG,
		ToolTip: "Loopra",
		Menu: mygo.NewMenu([]*mygo.MenuItem{
			{Label: openLabel, Click: func(*mygo.MenuItem, *mygo.Window) { resident.open() }},
			mygo.Separator(),
			{Label: quitLabel, Role: mygo.RoleQuit},
		}),
	})
	if err != nil {
		return fmt.Errorf("create tray: %w", err)
	}
	if err := checkTray(tray); err != nil {
		tray.Destroy()
		return err
	}
	tray.OnClick(resident.open)
	resident.trayAvailable = func() bool {
		if err := checkTray(tray); err != nil {
			logging.Errorf("desktop", "close to tray unavailable: %v", err)
			return false
		}
		return true
	}
	win.OnClose(resident.close)
	// Quit 菜单、Cmd+Q、更新重启和信号停机都必须真正关闭窗口。
	// mygo 的这些事件均在主线程触发，状态不跨 goroutine 共享。
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { resident.quitting = true })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { tray.Destroy() })
	return nil
}

type backgroundWindow interface {
	Hide()
	Show()
	IsMinimized() bool
	Restore()
	Focus()
}

type residentWindow struct {
	window        backgroundWindow
	quitting      bool
	trayAvailable func() bool
}

func (r *residentWindow) close(event *mygo.CloseEvent) {
	if r.quitting || r.trayAvailable == nil || !r.trayAvailable() {
		return
	}
	event.PreventDefault()
	r.window.Hide()
}

func (r *residentWindow) open() {
	if r.quitting {
		return
	}
	if r.window.IsMinimized() {
		r.window.Restore()
	}
	r.window.Show()
	r.window.Focus()
}

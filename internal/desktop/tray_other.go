//go:build !windows

package desktop

import "github.com/egoist/mygo"

func checkTray(*mygo.Tray) error { return nil }

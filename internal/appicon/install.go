package appicon

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Install 在 Linux 上把嵌在程序里的标志装进当前用户的图标主题和应用菜单。
// 其他系统没有这一步：Windows 的图标在 exe 里，macOS 的图标在 .app 里。
func Install() error {
	if runtime.GOOS != "linux" {
		return nil
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		data = filepath.Join(home, ".local", "share")
	}
	iconDir := filepath.Join(data, "icons", "hicolor", "512x512", "apps")
	if err := os.MkdirAll(iconDir, 0o755); err != nil {
		return err
	}
	if err := writeIfChanged(filepath.Join(iconDir, "com.ezdemo.looprax.png"), PNG, 0o644); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	apps := filepath.Join(data, "applications")
	if err := os.MkdirAll(apps, 0o755); err != nil {
		return err
	}
	desktop := "[Desktop Entry]\nType=Application\nVersion=1.0\nName=LoopraX\nComment=LoopraX 工作台\nExec=" +
		execField(exe) + "\nIcon=com.ezdemo.looprax\nTerminal=false\nCategories=Development;\nStartupWMClass=looprax\n"
	return writeIfChanged(filepath.Join(apps, "com.ezdemo.looprax.desktop"), []byte(desktop), 0o644)
}

func writeIfChanged(path string, data []byte, mode os.FileMode) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return nil
	}
	return os.WriteFile(path, data, mode)
}

func execField(path string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range path {
		if strings.ContainsRune("\"\\`$", r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

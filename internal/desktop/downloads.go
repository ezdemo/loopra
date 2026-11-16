package desktop

import (
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// HandleDownloads 把页面下载接到系统“另存为”对话框。页面里的导出
// （会话记录、会话管理、聊天文本）靠 <a download> 触发，mygo 默认把下载
// 静默写进下载目录并屏蔽 WebView2 的下载界面，界面上没有任何反馈。
// 取消对话框即放弃该次下载。
func HandleDownloads(win *mygo.Window) {
	win.Page().OnWillDownload(func(e *mygo.DownloadEvent) {
		path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
			Parent:      win,
			DefaultPath: e.Path,
			Filters:     downloadFilter(e.SuggestedName),
		})
		if err != nil {
			logging.Errorf("desktop", "save dialog: %v", err)
		}
		if path == "" {
			e.PreventDefault()
			return
		}
		e.Path = path
	})
	win.Page().OnDownloadDone(func(d *mygo.Download) {
		if d.Err == nil {
			return
		}
		title := "导出失败"
		if mygo.App.Locale() == "en" {
			title = "Export failed"
		}
		mygo.Dialog.Error(title, d.Err.Error())
	})
}

// downloadFilter 按建议文件名的扩展名给保存对话框一个过滤器，
// 这样用户改名不带扩展名时系统仍补上原扩展名。
func downloadFilter(suggested string) []mygo.FileFilter {
	ext := strings.TrimPrefix(filepath.Ext(suggested), ".")
	if ext == "" {
		return nil
	}
	return []mygo.FileFilter{{Name: strings.ToUpper(ext), Extensions: []string{ext}}}
}

// Package desktop 把工作台设置搬到 mygo 的原生窗口上：主题配色、界面语言。
//
// 两个桌面入口（looprax-desktop 和 looprax 的原生宠物窗口模式）都要用它，
// 所以放在这里，免得各写一份、漏掉一份。
package desktop

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
	// mygo 自带的原生界面文字（WebView2 的右键菜单、文件对话框等）的简体中文翻译。
	// 不导入时 mygo 认为这个应用只有英文，那些原生菜单就是英文的。
	_ "github.com/egoist/mygo/locales/zh-Hans"
)

// uiPreferencesFile 是工作台设置文件，和 controller 写在同一个位置。
// 这里只读 language 一项，就不引整个 controller 了。
const uiPreferencesFile = "ui-preferences.json"

// Background 是窗口在页面绘制之前铺的底色。theme 为空表示跟随系统。
func Background(theme string) string {
	switch theme {
	case "dark":
		return "#191919"
	case "light":
		return "#ffffff"
	default:
		return "light-dark(#ffffff, #191919)"
	}
}

// ApplyTheme 让原生窗口跟着工作台的深浅色设置。
func ApplyTheme(theme string) {
	switch theme {
	case "dark":
		mygo.Theme.SetSource(mygo.ThemeDark)
	case "light":
		mygo.Theme.SetSource(mygo.ThemeLight)
	case "system":
		mygo.Theme.SetSource(mygo.ThemeSystem)
	}
}

// ApplyLanguage 让 mygo 画的原生界面跟着工作台的界面语言走。
//
// 桌面端的右键菜单由 WebView2 自己画，它的语言取自 mygo 告诉 WebView2 环境的语言，
// 而那又取自应用声明支持的语言。不声明时 mygo 认为这个应用只有英文，右键菜单就是英文。
// WebView2 的语言只在创建环境时定一次，所以要在第一个窗口之前调用。
//
// home 是应用数据目录，语言设置就存在里面的 ui-preferences.json。
func ApplyLanguage(home string) {
	// 工作台界面本身只有中文，英文是给原生界面用的备选项。
	mygo.App.SetLanguages("zh-Hans", "en")
	if savedLanguage(home) == "en" {
		mygo.App.SetLocale("en")
		return
	}
	mygo.App.SetLocale("zh-Hans")
}

// savedLanguage 读已保存的界面语言（zh 或 en）。文件不存在或读不出来时返回空字符串，
// 由调用方按默认的中文处理。
func savedLanguage(home string) string {
	if home == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, uiPreferencesFile))
	if err != nil {
		return ""
	}
	var prefs struct {
		Language string `json:"language"`
	}
	if json.Unmarshal(data, &prefs) != nil {
		return ""
	}
	return prefs.Language
}

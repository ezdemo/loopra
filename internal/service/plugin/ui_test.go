package plugin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMenuIconCanDisablePluginIconInheritance(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	fallback := pkgIcon{Name: "braces"}
	hidden := h.iconRef("demo", "menu", parseIcon(json.RawMessage(`false`)), fallback)
	if hidden == nil || !hidden.Hidden || hidden.Name != "" || hidden.Key != "" {
		t.Fatalf("explicitly hidden icon = %+v", hidden)
	}
	inherited := h.iconRef("demo", "menu", parseIcon(nil), fallback)
	if inherited == nil || inherited.Hidden || inherited.Name != "braces" {
		t.Fatalf("inherited icon = %+v", inherited)
	}
	explicit := h.iconRef("demo", "menu", parseIcon(json.RawMessage(`"cat"`)), fallback)
	if explicit == nil || explicit.Hidden || explicit.Name != "cat" {
		t.Fatalf("explicit icon = %+v", explicit)
	}
}

func TestPluginMenusHaveIndependentNamesIconsAndPages(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	dir := h.pkgDir("multi")
	if err := os.MkdirAll(filepath.Join(dir, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"package.json":   `{"name":"multi","loopra":{"plugin":"./plugin.js","icon":"calendar","ui":{"menu":{"title":"业务接口","category":"工具与集成","icon":false,"children":[{"id":"orders","title":"订单查询","icon":"search","page":"./ui/orders.html"},{"id":"settings","title":"接口设置","icon":false,"page":"./ui/settings.html"},{"id":"report","title":"统计报告","icon":"./ui/report.svg","page":"./ui/report.html"},{"id":"history","title":"历史记录","page":"./ui/history.html"}]}}}}`,
		"ui/orders.html": "orders", "ui/settings.html": "settings", "ui/report.html": "report", "ui/history.html": "history",
		"ui/report.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
	}
	for name, value := range files {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	menu := h.menuView("multi", "插件默认名")
	if menu == nil || menu.Title != "业务接口" || menu.Icon == nil || !menu.Icon.Hidden || len(menu.Children) != 4 {
		t.Fatalf("menu = %+v", menu)
	}
	for i, want := range []struct{ id, title string }{{"orders", "订单查询"}, {"settings", "接口设置"}, {"report", "统计报告"}, {"history", "历史记录"}} {
		item := menu.Children[i]
		if item.ID != want.id || item.Title != want.title {
			t.Fatalf("item %d = %+v", i, item)
		}
		file, err := h.MenuFile("multi", item.ID)
		if err != nil || filepath.Base(file) != item.ID+".html" {
			t.Fatalf("page %s = %s %v", item.ID, file, err)
		}
	}
	if menu.Children[0].Icon == nil || menu.Children[0].Icon.Name != "search" || menu.Children[0].Icon.Hidden {
		t.Fatalf("named icon = %+v", menu.Children[0].Icon)
	}
	if menu.Children[1].Icon == nil || !menu.Children[1].Icon.Hidden {
		t.Fatalf("hidden icon = %+v", menu.Children[1].Icon)
	}
	if menu.Children[2].Icon == nil || menu.Children[2].Icon.Key != "item-report" {
		t.Fatalf("file icon = %+v", menu.Children[2].Icon)
	}
	if _, err := h.IconFile("multi", "item-report"); err != nil {
		t.Fatal(err)
	}
	if menu.Children[3].Icon == nil || menu.Children[3].Icon.Name != "calendar" || menu.Children[3].Icon.Hidden {
		t.Fatalf("inherited icon = %+v", menu.Children[3].Icon)
	}
}

func TestSettingsFileStaysInEntryDirectory(t *testing.T) {
	home := t.TempDir()
	h := New(home, Hooks{})
	dir := h.pkgDir("demo")
	if err := os.MkdirAll(filepath.Join(dir, "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json", `{"name":"demo","loopra":{"plugin":"./plugin.js","icon":"./ui/icon.svg","ui":{"settings":"./ui/index.html","sidebar":{"title":"侧栏","icon":"cat","page":"./ui/index.html"},"menu":{"title":"菜单","category":"工具与集成","icon":"./ui/icon.svg","children":[{"id":"nickname","title":"称呼","icon":"message-circle","page":"./ui/index.html"}]}}}}`)
	write("plugin.js", "secret")
	write("ui/index.html", "page")
	write("ui/icon.svg", `<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	write("ui/app.css", "body{}")
	write("ui/note.txt", "no")

	file, err := h.SettingsFile("demo", "")
	if err != nil || !strings.HasSuffix(file, "index.html") {
		t.Fatalf("entry = %s %v", file, err)
	}
	file, err = h.SettingsFile("demo", "app.css")
	if err != nil || !strings.HasSuffix(file, "app.css") {
		t.Fatalf("css = %s %v", file, err)
	}
	for _, rel := range []string{"../plugin.js", "..\\plugin.js", "note.txt", "/etc/passwd", "app.css/../../plugin.js"} {
		if _, err := h.SettingsFile("demo", rel); err == nil {
			t.Fatalf("rel %q was served", rel)
		}
	}
	link := filepath.Join(dir, "ui", "escape.html")
	if err := os.Symlink(filepath.Join(dir, "plugin.js"), link); err != nil {
		t.Logf("skip symlink: %v", err)
	} else if _, err := h.SettingsFile("demo", "escape.html"); err == nil {
		t.Fatal("symlink left the settings directory")
	}

	if err := h.upsert(record{ID: "demo", Name: "demo", DisplayName: "Demo", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	views := h.List()
	if len(views) != 1 || !views[0].Settings || views[0].Sidebar == nil || views[0].Sidebar.Title != "侧栏" || views[0].Sidebar.Icon == nil || views[0].Sidebar.Icon.Name != "cat" {
		t.Fatalf("list = %+v", views)
	}
	if views[0].Icon == nil || views[0].Icon.Key != "plugin" || views[0].Menu == nil || views[0].Menu.Title != "菜单" || views[0].Menu.Category != "工具与集成" || len(views[0].Menu.Children) != 1 || views[0].Menu.Children[0].Icon == nil || views[0].Menu.Children[0].Icon.Name != "message-circle" {
		t.Fatalf("menu = %+v icon = %+v", views[0].Menu, views[0].Icon)
	}
	if err := h.upsert(record{ID: "demo", Name: "demo", DisplayName: "Demo"}); err != nil {
		t.Fatal(err)
	}
	disabled := h.List()
	if len(disabled) != 1 || disabled[0].Sidebar != nil || disabled[0].Menu != nil || !disabled[0].Settings {
		t.Fatalf("disabled = %+v", disabled)
	}
	if _, err := h.IconFile("demo", "plugin"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IconFile("demo", "../plugin.js"); err == nil {
		t.Fatal("icon key escaped")
	}
	page, err := h.MenuFile("demo", "nickname")
	if err != nil || !strings.HasSuffix(page, "index.html") {
		t.Fatalf("menu page = %s %v", page, err)
	}
	if _, err := h.SidebarFile("demo", "../plugin.js"); err == nil {
		t.Fatal("sidebar path left the entry directory")
	}
	write("package.json", `{"name":"demo","loopra":{"plugin":"./plugin.js","icon":"../plugin.js"}}`)
	if _, err := h.IconFile("demo", "plugin"); err == nil {
		t.Fatal("icon file left the package")
	}
	write("package.json", `{"name":"demo","loopra":{"plugin":"./plugin.js","ui":{"settings":"./ui/index.html","sidebar":"./ui/index.html"}}}`)
	if title := h.SidebarTitle("demo", "Demo"); title != "Demo" {
		t.Fatalf("fallback title = %q", title)
	}
	if err := h.SetUIConfig("demo", map[string]any{"nickname": "主人"}); err != nil {
		t.Fatal(err)
	}
	got, err := h.UIConfig("demo")
	if err != nil || got["nickname"] != "主人" {
		t.Fatalf("config = %#v %v", got, err)
	}
	if err := h.Remove("demo"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(h.uiConfigPath("demo")); !os.IsNotExist(err) {
		t.Fatalf("config remained: %v", err)
	}
}

func TestUITicketMatchesOnlyItsPlugin(t *testing.T) {
	token, err := IssueUITicket("demo")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/plugins/demo/ui/index.html", nil)
	req.AddCookie(&http.Cookie{Name: UICookie, Value: token})
	if !ValidUIRequest(req) {
		t.Fatal("matching plugin was rejected")
	}
	side := httptest.NewRequest(http.MethodGet, "/api/plugins/demo/sidebar/", nil)
	side.AddCookie(&http.Cookie{Name: UICookie, Value: token})
	if !ValidUIRequest(side) {
		t.Fatal("sidebar page was rejected")
	}
	other := httptest.NewRequest(http.MethodGet, "/api/plugins/other/ui/", nil)
	other.AddCookie(&http.Cookie{Name: UICookie, Value: token})
	if ValidUIRequest(other) {
		t.Fatal("ticket opened another plugin")
	}
	post := httptest.NewRequest(http.MethodPost, "/api/plugins/demo/config", nil)
	post.AddCookie(&http.Cookie{Name: UICookie, Value: token})
	if ValidUIRequest(post) {
		t.Fatal("ticket authorized a write")
	}
}

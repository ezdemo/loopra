package plugin

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	write("package.json", `{"name":"demo","loopra":{"plugin":"./plugin.js","ui":{"settings":"./ui/index.html"}}}`)
	write("plugin.js", "secret")
	write("ui/index.html", "page")
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

	if err := h.upsert(record{ID: "demo", Name: "demo", DisplayName: "Demo"}); err != nil {
		t.Fatal(err)
	}
	views := h.List()
	if len(views) != 1 || !views[0].Settings {
		t.Fatalf("list = %+v", views)
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

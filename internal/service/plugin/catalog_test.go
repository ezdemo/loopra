package plugin

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPluginSourcesPersist(t *testing.T) {
	home := t.TempDir()
	h := New(home, Hooks{})
	sources, err := h.Sources()
	if err != nil || !reflect.DeepEqual(sources, []string{DefaultSource}) {
		t.Fatalf("defaults = %v, %v", sources, err)
	}
	for _, source := range []string{"github:ACME/Plugins#Release", "https://github.com/acme/plugins#Release"} {
		sources, err = h.SetSource(source, false)
		if err != nil || len(sources) != 2 {
			t.Fatalf("add/dedup = %v, %v", sources, err)
		}
	}
	sources, err = New(home, Hooks{}).Sources()
	if err != nil || len(sources) != 2 || sources[1] != "https://github.com/acme/plugins#Release" {
		t.Fatalf("reopen = %v, %v", sources, err)
	}
	for _, source := range sources {
		if _, err := h.SetSource(source, true); err != nil {
			t.Fatal(err)
		}
	}
	sources, err = New(home, Hooks{}).Sources()
	if err != nil || sources == nil || len(sources) != 0 {
		t.Fatalf("removed sources returned after restart: %v, %v", sources, err)
	}
	for _, source := range []string{"left-pad", "./plugins", "https://example.com/repo", "https://github.com/acme/plugins?path=../outside", "https://github.com/acme/plugins?path=C:/outside"} {
		if _, err := h.SetSource(source, false); err == nil {
			t.Errorf("accepted invalid repository %q", source)
		}
	}
}

func TestCatalogIncludesIconsBeforeInstallation(t *testing.T) {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>`
	for _, tc := range []struct {
		name, declaration, file, data string
		wantName                      string
		wantImage, wantHidden         bool
	}{
		{name: "named", declaration: `"calendar"`, wantName: "calendar"},
		{name: "file", declaration: `"./ui/icon.svg"`, file: "ui/icon.svg", data: svg, wantImage: true},
		{name: "hidden", declaration: `false`, wantHidden: true},
		{name: "missing", declaration: `"./ui/missing.svg"`},
		{name: "oversized", declaration: `"./ui/icon.svg"`, file: "ui/icon.svg", data: strings.Repeat("x", (256<<10)+1)},
		{name: "outside", declaration: `"../icon.svg"`, file: "icon.svg", data: svg},
		{name: "non-image", declaration: `"./ui/icon.html"`, file: "ui/icon.html", data: "<script>bad()</script>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{
				"repo/package.json": fmt.Sprintf(`{"name":"icon-demo","loopra":{"plugin":"plugin.js","icon":%s}}`, tc.declaration),
				"repo/plugin.js":    `throw new Error("catalog must not execute plugins");`,
			}
			if tc.file != "" {
				files["repo/"+tc.file] = tc.data
			}
			h := New(t.TempDir(), Hooks{})
			archive := tarGz(files)
			h.Fetcher = func(context.Context, string) ([]byte, error) { return archive, nil }
			entries, err := h.Catalog(context.Background(), DefaultSource)
			if err != nil || len(entries) != 1 {
				t.Fatalf("catalog = %+v, %v", entries, err)
			}
			icon := entries[0].Icon
			if !tc.wantImage && !tc.wantHidden && tc.wantName == "" {
				if icon != nil {
					t.Fatalf("invalid icon accepted: %+v", icon)
				}
				return
			}
			if icon == nil || icon.Name != tc.wantName || icon.Hidden != tc.wantHidden {
				t.Fatalf("icon = %+v", icon)
			}
			if tc.wantImage {
				prefix := "data:image/svg+xml;base64,"
				if !strings.HasPrefix(icon.DataURL, prefix) {
					t.Fatalf("icon data URL = %q", icon.DataURL)
				}
				data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(icon.DataURL, prefix))
				if err != nil || string(data) != svg {
					t.Fatalf("file icon did not survive catalog cleanup: %q, %v", data, err)
				}
			}
			if len(h.List()) != 0 {
				t.Fatal("reading an icon installed the plugin")
			}
		})
	}
}

func TestCatalogInstallAndRemove(t *testing.T) {
	ctx := context.Background()
	home := t.TempDir()
	h := New(home, Hooks{})
	defer h.drop("alpha")
	archive := tarGz(map[string]string{
		"repo/plugins/alpha/package.json":           `{"name":"alpha","version":"1.2.0","description":"Alpha plugin","loopra":"plugin.js"}`,
		"repo/plugins/alpha/plugin.js":              `export function ping() { return { text: "alpha" }; }`,
		"repo/packages/beta/package.json":           `{"name":"beta","version":"2.0.0"}`,
		"repo/packages/beta/plugin.ts":              `export function ping() { return { text: "beta" }; }`,
		"repo/web/package.json":                     `{"name":"website"}`,
		"repo/broken/package.json":                  `{"name":"broken","loopra":"missing.js"}`,
		"repo/node_modules/dependency/package.json": `{"name":"dependency","main":"index.js"}`,
		"repo/node_modules/dependency/index.js":     `throw new Error("must not run");`,
		"repo/.hidden/package.json":                 `{"name":"hidden"}`,
		"repo/.hidden/plugin.js":                    `throw new Error("must not run");`,
	})
	h.Fetcher = func(ctx context.Context, rawURL string) ([]byte, error) {
		if rawURL != "https://codeload.github.com/acme/plugins/tar.gz/refs/heads/feature/plugins" {
			return nil, fmt.Errorf("unexpected URL %s", rawURL)
		}
		return archive, nil
	}
	entries, err := h.Catalog(ctx, "github:acme/plugins#feature/plugins")
	if err != nil || len(entries) != 2 || entries[0].Name != "alpha" || entries[1].Name != "beta" || entries[0].Version != "1.2.0" {
		t.Fatalf("catalog = %+v, %v", entries, err)
	}
	if len(h.List()) != 0 || len(h.Bound()) != 0 {
		t.Fatal("browsing catalog installed or executed a plugin")
	}
	parsed, err := parseSource(entries[0].Source)
	if err != nil || parsed.Ref != "feature/plugins" || parsed.Subdir != "plugins/alpha" {
		t.Fatalf("entry source = %+v, %v", parsed, err)
	}
	view, err := h.Install(ctx, entries[0].Source)
	if err != nil || view.ID != "alpha" || len(h.Bound()) != 1 {
		t.Fatalf("install = %+v, %v", view, err)
	}
	out, err := h.Bound()[0].Call(ctx, map[string]any{})
	if err != nil || out["text"] != "alpha" {
		t.Fatalf("plugin result = %v, %v", out, err)
	}
	if _, err := h.SetSource("github:acme/plugins#feature/plugins", false); err != nil {
		t.Fatal(err)
	}
	if _, err := h.SetSource("github:acme/plugins#feature/plugins", true); err != nil {
		t.Fatal(err)
	}
	if !h.Installed("alpha") || len(h.Bound()) != 1 {
		t.Fatal("removing a source uninstalled its plugin")
	}
	if err := h.Remove("alpha"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "plugins", "packages", "alpha")); !os.IsNotExist(err) || len(h.Bound()) != 0 {
		t.Fatalf("plugin files or tools remained: %v", err)
	}
	entries, err = h.Catalog(ctx, "https://github.com/acme/plugins?path=plugins#feature/plugins")
	if err != nil || len(entries) != 1 || entries[0].ID != "alpha" {
		t.Fatalf("subdirectory catalog = %+v, %v", entries, err)
	}
}

func TestCatalogValidation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files map[string]string
		want  int
		fail  bool
	}{
		{"empty", map[string]string{"repo/README.md": "empty catalog"}, 0, false},
		{"root plugin", map[string]string{"repo/package.json": `{"name":"root"}`, "repo/plugin.js": `throw new Error("catalog must not execute code");`}, 1, false},
		{"duplicate IDs", map[string]string{"repo/a/package.json": `{"name":"a-b"}`, "repo/a/plugin.js": "export function ping() {}", "repo/b/package.json": `{"name":"a_b"}`, "repo/b/plugin.js": "export function ping() {}"}, 0, true},
		{"archive escape", map[string]string{"../outside": "bad"}, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := New(t.TempDir(), Hooks{})
			archive := tarGz(tc.files)
			h.Fetcher = func(context.Context, string) ([]byte, error) { return archive, nil }
			entries, err := h.Catalog(context.Background(), DefaultSource)
			if (err != nil) != tc.fail || !tc.fail && (entries == nil || len(entries) != tc.want) {
				t.Fatalf("entries = %+v, error = %v", entries, err)
			}
		})
	}
	h := New(t.TempDir(), Hooks{})
	h.Fetcher = func(context.Context, string) ([]byte, error) { return nil, fmt.Errorf("404") }
	if _, err := h.Catalog(context.Background(), DefaultSource); err == nil || !strings.Contains(err.Error(), "已有提交") {
		t.Fatalf("empty repository error = %v", err)
	}
}

package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeUpdatePlugin(t *testing.T, dir, name, version, code string) {
	t.Helper()
	for file, body := range map[string]string{
		"package.json": fmt.Sprintf(`{"name":%q,"version":%q,"loopra":"plugin.js"}`, name, version),
		"plugin.js":    code,
	} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUpdatePreservesStateAndReplacesTools(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			ctx := context.Background()
			registry := map[string]BoundTool{}
			h := New(t.TempDir(), Hooks{
				Bind: func(tools []BoundTool) {
					for _, tool := range tools {
						registry[tool.Name] = tool
					}
				},
				Unbind: func(names []string) {
					for _, name := range names {
						delete(registry, name)
					}
				},
			})
			dir := t.TempDir()
			writeUpdatePlugin(t, dir, "demo", "1.0.0", `export function oldTool() { return {text:"old"}; }`)
			if _, err := h.Install(ctx, dir); err != nil {
				t.Fatal(err)
			}
			if _, err := h.SetEnabled(ctx, "demo", enabled); err != nil {
				t.Fatal(err)
			}
			before, _ := h.pluginRecord("demo")
			if err := h.SetUIConfig("demo", map[string]any{"keep": "value"}); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(h.dataDir("demo"), 0700); err != nil {
				t.Fatal(err)
			}
			dataPath := filepath.Join(h.dataDir("demo"), "saved.txt")
			if err := os.WriteFile(dataPath, []byte("saved"), 0600); err != nil {
				t.Fatal(err)
			}
			writeUpdatePlugin(t, dir, "demo", "2.0.0", `export const meta = {displayName:"New Demo"}; export function newTool() { return {text:"new"}; }`)
			view, err := h.Update(ctx, "demo")
			if err != nil || view.Version != "2.0.0" || view.DisplayName != "New Demo" || view.Enabled != enabled {
				t.Fatalf("update = %+v, %v", view, err)
			}
			after, _ := h.pluginRecord("demo")
			if after.InstalledAt != before.InstalledAt || after.Source != before.Source {
				t.Fatalf("record = %+v", after)
			}
			cfg, err := h.UIConfig("demo")
			if err != nil || cfg["keep"] != "value" {
				t.Fatalf("config = %v, %v", cfg, err)
			}
			if data, err := os.ReadFile(dataPath); err != nil || string(data) != "saved" {
				t.Fatalf("data = %s, %v", data, err)
			}
			if _, exists := registry["demo__oldTool"]; exists {
				t.Fatal("old tool still registered")
			}
			if _, exists := registry["demo__newTool"]; exists != enabled {
				t.Fatalf("registry = %v", registry)
			}
			if _, err := h.SetEnabled(ctx, "demo", true); err != nil {
				t.Fatal(err)
			}
			out, err := h.Bound()[0].Call(ctx, nil)
			if err != nil || out["text"] != "new" {
				t.Fatalf("new tool = %v, %v", out, err)
			}
			reopened := New(h.home, Hooks{})
			if saved := reopened.view("demo"); saved.Version != "2.0.0" {
				t.Fatalf("saved = %+v", saved)
			}
		})
	}
}

func TestFailedUpdatePreservesFilesManifestAndRuntime(t *testing.T) {
	for _, failure := range []string{"syntax", "name", "download", "manifest"} {
		t.Run(failure, func(t *testing.T) {
			ctx := context.Background()
			h := New(t.TempDir(), Hooks{})
			dir := t.TempDir()
			writeUpdatePlugin(t, dir, "demo", "1.0.0", `export function ping() { return {text:"old"}; }`)
			if _, err := h.Install(ctx, dir); err != nil {
				t.Fatal(err)
			}
			before, _ := h.pluginRecord("demo")
			oldRuntime := h.loaded["demo"]
			manifest, err := os.ReadFile(h.manifestPath())
			if err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "syntax":
				writeUpdatePlugin(t, dir, "demo", "2.0.0", `export function ping( {`)
			case "name":
				writeUpdatePlugin(t, dir, "other", "2.0.0", `export function ping() { return {}; }`)
			case "download":
				if err := os.Remove(filepath.Join(dir, "plugin.js")); err != nil {
					t.Fatal(err)
				}
			case "manifest":
				writeUpdatePlugin(t, dir, "demo", "2.0.0", `export function ping() { return {text:"new"}; }`)
				if err := os.Remove(h.manifestPath()); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(h.manifestPath(), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.Update(ctx, "demo"); err == nil {
				t.Fatal("update should fail")
			}
			after, _ := h.pluginRecord("demo")
			if !reflect.DeepEqual(before, after) || h.loaded["demo"] != oldRuntime || h.view("demo").Error != "" {
				t.Fatalf("old version changed: %+v", after)
			}
			if failure != "manifest" {
				saved, err := os.ReadFile(h.manifestPath())
				if err != nil || string(saved) != string(manifest) {
					t.Fatalf("manifest changed: %s, %v", saved, err)
				}
			}
			out, err := h.Bound()[0].Call(ctx, nil)
			if err != nil || out["text"] != "old" {
				t.Fatalf("old runtime = %v, %v", out, err)
			}
			if pkg := readPkg(h.pkgDir("demo")); pkg.Version != "1.0.0" {
				t.Fatalf("old files lost: %+v", pkg)
			}
		})
	}
}

func TestUpdateNPMUsesLatestAndGitHubKeepsRefAndSubdir(t *testing.T) {
	ctx := context.Background()
	for _, source := range []string{"demo@1.0.0", "https://github.com/acme/repo/tree/dev/plugins/demo"} {
		t.Run(source, func(t *testing.T) {
			h := New(t.TempDir(), Hooks{})
			version := "1.0.0"
			var requested []string
			h.Fetcher = func(_ context.Context, rawURL string) ([]byte, error) {
				requested = append(requested, rawURL)
				prefix := "package/"
				if strings.Contains(source, "github.com") {
					if !strings.HasSuffix(rawURL, "/tar.gz/dev") {
						return nil, fmt.Errorf("wrong ref: %s", rawURL)
					}
					prefix = "repo-dev/plugins/demo/"
				} else if !strings.HasSuffix(rawURL, ".tgz") {
					return []byte(fmt.Sprintf(`{"version":%q,"dist":{"tarball":"https://registry.npmjs.org/demo/-/demo.tgz"}}`, version)), nil
				}
				return tarGz(map[string]string{
					prefix + "package.json": fmt.Sprintf(`{"name":"demo","version":%q}`, version),
					prefix + "plugin.js":    `export function ping(){return {};}`,
				}), nil
			}
			if _, err := h.Install(ctx, source); err != nil {
				t.Fatal(err)
			}
			version = "2.0.0"
			requested = nil
			view, err := h.Update(ctx, "demo")
			if err != nil || view.Version != version || view.Source != source {
				t.Fatalf("update = %+v, %v", view, err)
			}
			if !strings.Contains(source, "github.com") && !strings.HasSuffix(requested[0], "/demo/latest") {
				t.Fatalf("not latest: %v", requested)
			}
		})
	}
}

func TestUpdateRejectsMissingAndBuiltin(t *testing.T) {
	ctx := context.Background()
	h := New(t.TempDir(), Hooks{})
	for _, id := range []string{"missing", "../escape"} {
		if _, err := h.Update(ctx, id); err == nil {
			t.Fatalf("accepted %s", id)
		}
	}
	dir := t.TempDir()
	writeUpdatePlugin(t, dir, "demo", "1.0.0", `export function ping(){return {};}`)
	if _, err := h.Install(ctx, dir); err != nil {
		t.Fatal(err)
	}
	h.setBuiltin("demo", true)
	if _, err := h.Update(ctx, "demo"); err == nil || !strings.Contains(err.Error(), "内置") {
		t.Fatalf("builtin = %v", err)
	}
}

func TestReinstallPreservesDisabledState(t *testing.T) {
	ctx := context.Background()
	h := New(t.TempDir(), Hooks{})
	dir := t.TempDir()
	writeUpdatePlugin(t, dir, "demo", "1.0.0", `export function ping(){return {};}`)
	if _, err := h.Install(ctx, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := h.SetEnabled(ctx, "demo", false); err != nil {
		t.Fatal(err)
	}
	writeUpdatePlugin(t, dir, "demo", "2.0.0", `export function ping(){return {};}`)
	view, err := h.Install(ctx, dir)
	if err != nil || view.Enabled || view.Version != "2.0.0" || len(h.Bound()) != 0 {
		t.Fatalf("reinstall = %+v, %v", view, err)
	}
}

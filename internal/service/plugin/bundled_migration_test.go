package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestExternalizedBundledPluginsPreserveUserState(t *testing.T) {
	ctx := context.Background()
	h := New(t.TempDir(), Hooks{})
	before := map[string]record{}
	for index, name := range []string{"chat-neko", "daily-review", "openapi", "context-lens"} {
		dir := t.TempDir()
		for file, data := range map[string]string{
			"package.json": fmt.Sprintf(`{"name":%q,"loopra":"plugin.js"}`, name),
			"plugin.js":    "export function systemPrompt() { return {}; }",
		} {
			if err := os.WriteFile(filepath.Join(dir, file), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
		}
		view, err := h.Install(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		h.setBuiltin(view.ID, true)
		if _, err := h.SetEnabled(ctx, view.ID, index%2 == 0); err != nil {
			t.Fatal(err)
		}
		if err := h.SetUIConfig(view.ID, map[string]any{"keep": name}); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(h.dataDir(view.ID), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(h.dataDir(view.ID), "saved.txt"), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
		before[view.ID], _ = h.pluginRecord(view.ID)
	}
	h.EnsureBundled(ctx)
	for id, previous := range before {
		rec, ok := h.pluginRecord(id)
		src, err := parseSource(rec.Source)
		if !ok || rec.Builtin || rec.Enabled != previous.Enabled || rec.InstalledAt != previous.InstalledAt || err != nil || src.Owner != "ezdemo" || src.Repo != "loopra-plugins" || src.Subdir != "plugins/"+previous.Name {
			t.Fatalf("migration %s: %+v, source=%+v, error=%v", id, rec, src, err)
		}
		config, err := h.UIConfig(id)
		if err != nil || config["keep"] != previous.Name {
			t.Fatalf("configuration lost for %s: %v, %v", id, config, err)
		}
		if data, err := os.ReadFile(filepath.Join(h.dataDir(id), "saved.txt")); err != nil || string(data) != previous.Name {
			t.Fatalf("data lost for %s: %s, %v", id, data, err)
		}
		if err := h.Remove(id); err != nil {
			t.Fatalf("externalized plugin %s cannot be uninstalled: %v", id, err)
		}
	}
}

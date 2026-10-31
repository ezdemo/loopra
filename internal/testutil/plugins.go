// Package testutil provides fixtures for integration tests.
package testutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ExternalPlugin locates the optional loopra-plugins checkout. Plugin-specific
// integration tests run when it is cloned beside Loopra or explicitly selected.
func ExternalPlugin(t *testing.T, name string) string {
	t.Helper()
	root := os.Getenv("LOOPRA_PLUGIN_SOURCE_DIR")
	explicit := root != ""
	if !explicit {
		_, file, _, ok := runtime.Caller(0)
		if !ok {
			t.Fatal("cannot locate plugin test fixtures")
		}
		root = filepath.Join(filepath.Dir(file), "..", "..", "..", "loopra-plugins")
	}
	dir := filepath.Join(root, "plugins", name)
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		if explicit {
			t.Fatalf("LOOPRA_PLUGIN_SOURCE_DIR is missing plugin %s: %v", name, err)
		}
		t.Skip("clone ezdemo/loopra-plugins beside Loopra to run external plugin integration tests")
	}
	return dir
}

// Package updatecleanup removes obsolete Loopra backups left by older updaters.
package updatecleanup

import (
	"debug/buildinfo"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// LegacyBackup removes only the running application's exact .old sibling, and
// only after its embedded Go metadata identifies it as a Loopra executable.
// A macOS bundle is checked through its executable before removing the folder.
func LegacyBackup(executable string) error {
	executable, err := filepath.Abs(executable)
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	target := executable
	bundle := filepath.Base(filepath.Dir(executable)) == "MacOS" && filepath.Base(filepath.Dir(filepath.Dir(executable))) == "Contents"
	if bundle {
		target = filepath.Dir(filepath.Dir(filepath.Dir(executable)))
		if !strings.HasSuffix(target, ".app") {
			return nil
		}
	}
	backup := target + ".old"
	info, err := os.Lstat(backup)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.IsDir() != bundle {
		return nil
	}
	if !bundle && !info.Mode().IsRegular() {
		return nil
	}
	oldExecutable := backup
	if bundle {
		oldExecutable = filepath.Join(backup, "Contents", "MacOS", filepath.Base(executable))
	}
	build, err := buildinfo.ReadFile(oldExecutable)
	if err != nil || build.Main.Path != "github.com/ezdemo/looprax" {
		return nil
	}
	if build.Path != "github.com/ezdemo/looprax/cmd/looprax" && build.Path != "github.com/ezdemo/looprax/cmd/looprax-desktop" {
		return nil
	}
	if bundle {
		return os.RemoveAll(backup)
	}
	err = os.Remove(backup)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

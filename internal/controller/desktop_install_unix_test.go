package controller

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func shellTestPath(path string) string {
	path = filepath.ToSlash(path)
	if len(path) > 2 && path[1] == ':' {
		return "/" + strings.ToLower(path[:1]) + path[2:]
	}
	return path
}

func TestDesktopUnixUpdatesCleanBackupsAndRestoreFailedReplacement(t *testing.T) {
	shell := "/bin/sh"
	if runtime.GOOS == "windows" {
		shell = `C:\Program Files\Git\bin\bash.exe`
		if _, err := os.Stat(shell); err != nil {
			t.Skip("Git Bash is required to exercise Unix update scripts on Windows")
		}
	}
	for _, platform := range []string{"darwin", "linux"} {
		for _, fail := range []bool{false, true} {
			t.Run(platform+map[bool]string{false: "-success", true: "-failure"}[fail], func(t *testing.T) {
				work := t.TempDir()
				tools := filepath.Join(work, "tools")
				os.Mkdir(tools, 0o755)
				for name, script := range map[string]string{
					"ditto": "#!/bin/sh\nexec cp -R \"$1\" \"$2\"\n",
					"open":  "#!/bin/sh\nexit 0\n", "xattr": "#!/bin/sh\nexit 0\n", "nohup": "#!/bin/sh\nexit 0\n",
					"mv": "#!/bin/sh\nif [ -n \"${LOOPRA_TEST_FAIL_REPLACE-}\" ] && [ \"${2-}\" = \"$LOOPRA_TEST_FAIL_REPLACE\" ]; then exit 9; fi\nexec /bin/mv \"$@\"\n",
				} {
					os.WriteFile(filepath.Join(tools, name), []byte(script), 0o755)
				}
				target, staged := filepath.Join(work, "loopra"), filepath.Join(work, "package")
				if platform == "darwin" {
					target, staged = filepath.Join(work, "Loopra.app"), filepath.Join(work, "staged.app")
					os.Mkdir(target, 0o755)
					os.Mkdir(staged, 0o755)
					os.WriteFile(filepath.Join(target, "payload"), []byte("old"), 0o600)
					os.WriteFile(filepath.Join(staged, "payload"), []byte("new"), 0o600)
				} else {
					os.WriteFile(target, []byte("old"), 0o755)
					os.WriteFile(staged, []byte("new"), 0o755)
				}
				helper := filepath.Join(work, "apply.sh")
				os.WriteFile(helper, []byte(desktopApplyUnix), 0o700)
				cmd := exec.Command(shell, "-c", `PATH="$LOOPRA_TEST_TOOLS:$PATH"; export PATH; exec sh "$@"`, "test", shellTestPath(helper), "2147483647", shellTestPath(target), shellTestPath(staged), shellTestPath(work), platform)
				cmd.Env = append(os.Environ(), "LOOPRA_TEST_TOOLS="+shellTestPath(tools))
				if fail {
					cmd.Env = append(cmd.Env, "LOOPRA_TEST_FAIL_REPLACE="+shellTestPath(target+".new"))
				}
				output, err := cmd.CombinedOutput()
				if (err != nil) != fail {
					t.Fatalf("apply error = %v, fail=%v\n%s", err, fail, output)
				}
				payload := target
				if platform == "darwin" {
					payload = filepath.Join(target, "payload")
				}
				want := "new"
				if fail {
					want = "old"
				}
				if data, _ := os.ReadFile(payload); string(data) != want {
					t.Fatalf("application = %s, want %s", data, want)
				}
				if _, err := os.Stat(target + ".old"); !os.IsNotExist(err) {
					t.Fatal("update left an .old sibling")
				}
			})
		}
	}
}

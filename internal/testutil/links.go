package testutil

import (
	"os"
	"os/exec"
	"runtime"
	"testing"
)

// DirectoryLink creates a symlink, or a junction on Windows without symlink privileges.
func DirectoryLink(t *testing.T, link, target string) {
	t.Helper()
	if err := os.Symlink(target, link); err == nil {
		return
	} else if runtime.GOOS != "windows" {
		t.Fatalf("create directory link: %v", err)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Junction -Path $env:LOOPRA_TEST_LINK -Target $env:LOOPRA_TEST_TARGET -ErrorAction Stop | Out-Null`)
	cmd.Env = append(os.Environ(), "LOOPRA_TEST_LINK="+link, "LOOPRA_TEST_TARGET="+target)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create junction: %s: %v", output, err)
	}
}

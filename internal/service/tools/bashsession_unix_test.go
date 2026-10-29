//go:build unix

package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

func TestUnixShellStopKillsDescendants(t *testing.T) {
	for _, executable := range []string{"bash", "sh"} {
		for _, mode := range []string{"stop", "exit"} {
			t.Run(executable+"/"+mode, func(t *testing.T) {
				path, err := exec.LookPath(executable)
				if err != nil {
					t.Skip(err)
				}
				root := t.TempDir()
				command := "sh -c 'sleep 300 & echo $! > grandchild.pid; wait' &\necho $! > child.pid\n"
				if mode == "exit" {
					// Wait for the nested shell to spawn the grandchild before exiting.
					command += "while [ ! -s grandchild.pid ]; do sleep 0.02; done\nexit"
				} else {
					command += "wait"
				}
				s, err := startShellSession(root, command, shellenv.Shell{Name: executable, Path: path})
				if err != nil {
					t.Fatal(err)
				}
				defer BashSessionTerminate(s.id)
				pids := []int{waitForSessionPID(t, root, "child.pid"), waitForSessionPID(t, root, "grandchild.pid")}
				if mode == "stop" {
					if err := s.stop(); err != nil {
						t.Fatal(err)
					}
				}
				select {
				case <-s.done:
				case <-time.After(5 * time.Second):
					t.Fatal("shell cleanup hung on descendant output pipes")
				}
				for _, pid := range pids {
					deadline := time.Now().Add(5 * time.Second)
					for sessionProcessRunning(pid) && time.Now().Before(deadline) {
						time.Sleep(20 * time.Millisecond)
					}
					if sessionProcessRunning(pid) {
						process, _ := os.FindProcess(pid)
						process.Kill()
						process.Release()
						t.Errorf("descendant %d survived session %s", pid, mode)
					}
				}
			})
		}
	}
}

func waitForSessionPID(t *testing.T, root, name string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(filepath.Join(root, name))
		if err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("shell did not create %s", name)
	return 0
}

func sessionProcessRunning(pid int) bool {
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	state := strings.TrimSpace(string(out))
	return err == nil && state != "" && !strings.HasPrefix(state, "Z")
}

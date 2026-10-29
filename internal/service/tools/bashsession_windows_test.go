package tools

import (
	"os/exec"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

func TestWindowsShellStopKillsPing(t *testing.T) {
	for _, executable := range []string{"pwsh.exe", "powershell.exe", "cmd.exe"} {
		t.Run(executable, func(t *testing.T) {
			path, err := exec.LookPath(executable)
			if err != nil {
				t.Skip(err)
			}
			name := "powershell"
			if executable == "cmd.exe" {
				name = "CMD"
			}
			s, err := startShellSession(t.TempDir(), "ping.exe -t 127.0.0.1", shellenv.Shell{Name: name, Path: path})
			if err != nil {
				t.Fatal(err)
			}
			defer BashSessionTerminate(s.id)
			ping := waitForPing(t, uint32(s.proc.Process.Pid))
			defer windows.CloseHandle(ping)
			if err := s.stop(); err != nil {
				t.Fatal(err)
			}
			state, err := windows.WaitForSingleObject(ping, 5000)
			if err != nil || state != windows.WAIT_OBJECT_0 {
				t.Fatalf("PING survived shell stop: state=%d error=%v", state, err)
			}
			select {
			case <-s.done:
			case <-time.After(5 * time.Second):
				t.Fatal("shell did not finish after stopping its process tree")
			}
			if got := s.statusLocked(); got != "stopped" {
				t.Fatalf("status = %s", got)
			}
		})
	}
}

func waitForPing(t *testing.T, parent uint32) windows.Handle {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
		if err != nil {
			t.Fatal(err)
		}
		entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
		for err := windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
			if entry.ParentProcessID == parent && strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "ping.exe") {
				handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, entry.ProcessID)
				windows.CloseHandle(snapshot)
				if err != nil {
					t.Fatal(err)
				}
				return handle
			}
		}
		windows.CloseHandle(snapshot)
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("shell did not spawn PING")
	return 0
}

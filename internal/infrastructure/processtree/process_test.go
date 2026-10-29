package processtree

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func helperCommand(root string, depth int, mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestTreeHelperProcess$", "--", root, strconv.Itoa(depth), mode)
	cmd.Env = append(os.Environ(), "LOOPRAX_TREE_HELPER=1")
	return cmd
}

// This subprocess deliberately leaves child and grandchild processes running.
func TestTreeHelperProcess(t *testing.T) {
	if os.Getenv("LOOPRAX_TREE_HELPER") != "1" {
		return
	}
	args := os.Args[len(os.Args)-3:]
	root, mode := args[0], args[2]
	depth, err := strconv.Atoi(args[1])
	if err != nil {
		t.Fatal(err)
	}
	if depth > 0 {
		child := helperCommand(root, depth-1, "wait")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("%d.pid", depth)), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	if mode == "exit" {
		waitForPIDs(t, root, depth)
		return
	}
	time.Sleep(5 * time.Minute)
}

func waitForPIDs(t *testing.T, root string, depth int) []int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var pids []int
		for i := 0; i <= depth; i++ {
			raw, err := os.ReadFile(filepath.Join(root, fmt.Sprintf("%d.pid", i)))
			if err != nil {
				break
			}
			pid, err := strconv.Atoi(string(raw))
			if err != nil {
				break
			}
			pids = append(pids, pid)
		}
		if len(pids) == depth+1 {
			return pids
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("helper process tree did not start")
	return nil
}

func requireStopped(t *testing.T, pids []int) {
	t.Helper()
	for _, pid := range pids {
		deadline := time.Now().Add(5 * time.Second)
		for processRunning(pid) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if processRunning(pid) {
			if process, err := os.FindProcess(pid); err == nil {
				process.Kill()
				process.Release()
			}
			t.Errorf("process %d survived tree cleanup", pid)
		}
	}
}

func TestKillIncludesChildrenAndGrandchildren(t *testing.T) {
	root := t.TempDir()
	cmd := helperCommand(root, 2, "wait")
	tree, err := Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Kill()
	pids := waitForPIDs(t, root, 2)

	other := helperCommand(t.TempDir(), 0, "wait")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { other.Process.Kill(); other.Wait() }()
	if err := tree.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	requireStopped(t, pids)
	if err := tree.Kill(); err != nil {
		t.Fatal("repeated cleanup failed:", err)
	}
	if !processRunning(other.Process.Pid) {
		t.Fatal("cleanup killed an unrelated process")
	}
}

func TestCombinedOutputCleansUpOnExitAndCancellation(t *testing.T) {
	for _, mode := range []string{"exit", "cancel", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			cmd := helperCommand(root, 2, "wait")
			if mode == "exit" {
				cmd = helperCommand(root, 2, "exit")
			} else {
				managed := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
				managed.Env = cmd.Env
				cmd = managed
			}
			finished := make(chan error, 1)
			go func() {
				_, err := CombinedOutput(cmd)
				finished <- err
			}()
			pids := waitForPIDs(t, root, 2)
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-finished:
				if mode == "exit" && err != nil {
					t.Fatal(err)
				}
				if mode != "exit" && err == nil {
					t.Fatal("canceled command reported success")
				}
			case <-time.After(10 * time.Second):
				t.Error("command hung on inherited output pipes")
			}
			requireStopped(t, pids)
		})
	}
}

func TestStartWithCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTreeHelperProcess$")
	if _, err := Start(cmd); err == nil {
		t.Fatal("started a command after context cancellation")
	}
}

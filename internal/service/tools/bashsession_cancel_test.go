package tools

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/toolconfirmation"
)

type cancellableShellContext struct {
	agentpkg.Context
	base context.Context
}

func (c cancellableShellContext) Deadline() (time.Time, bool) { return c.base.Deadline() }
func (c cancellableShellContext) Done() <-chan struct{}       { return c.base.Done() }
func (c cancellableShellContext) Err() error                  { return c.base.Err() }
func (c cancellableShellContext) Value(key any) any           { return c.base.Value(key) }
func (c cancellableShellContext) ToolConfirmation() *toolconfirmation.ToolConfirmation {
	return nil
}

type runnableShellTool interface {
	Run(agentpkg.Context, any) (map[string]any, error)
}

type blockedShellInput struct {
	writing, closed chan struct{}
	once            sync.Once
}

func (w *blockedShellInput) Write([]byte) (int, error) {
	close(w.writing)
	<-w.closed
	return 0, io.ErrClosedPipe
}

func (w *blockedShellInput) Close() error {
	w.once.Do(func() { close(w.closed) })
	return nil
}

func TestInteractiveStdinCancellationUnblocksWrite(t *testing.T) {
	owner := testSessionOwner("blocked-stdin")
	ctx, cancel := context.WithCancel(WithSessionOwner(t.Context(), owner))
	defer cancel()
	input := &blockedShellInput{writing: make(chan struct{}), closed: make(chan struct{})}
	s := &bashSession{id: newBashID(), owner: owner, stdin: input, wakeup: make(chan struct{}, 1), status: "running"}
	bashMu.Lock()
	bashSessions[s.id] = s
	bashMu.Unlock()
	t.Cleanup(func() { BashSessionTerminate(s.id, owner) })
	finished := make(chan error, 1)
	go func() {
		_, err := bashStdinTool().(runnableShellTool).Run(cancellableShellContext{base: ctx},
			map[string]any{"session_id": s.id, "input": "cannot be consumed", "timeout_ms": 3600000})
		finished <- err
	}()
	select {
	case <-input.writing:
	case <-time.After(time.Second):
		t.Fatal("tool did not reach its stdin write")
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("stdin error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("stdin write remained blocked after cancellation")
	}
}

func waitForOwnedShell(t *testing.T, owner SessionOwner) *bashSession {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, row := range BashSessionsSnapshot(owner) {
			if s, ok := findBashSession(row["sessionId"].(string), owner); ok {
				return s
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("shell did not start")
	return nil
}

func requireShellExited(t *testing.T, s *bashSession) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
		t.Fatal("shell process did not exit after cancellation")
	}
	if status := s.statusLocked(); status != "stopped" {
		t.Fatalf("shell status = %s", status)
	}
}

func TestInteractiveShellToolsCancelImmediately(t *testing.T) {
	for _, name := range []string{"start", "wait", "stdin"} {
		t.Run(name, func(t *testing.T) {
			owner := testSessionOwner("cancel-" + name)
			ctx, cancel := context.WithCancel(WithSessionOwner(t.Context(), owner))
			defer cancel()
			t.Cleanup(func() { BashSessionTerminate("", owner) })
			toolCtx := cancellableShellContext{base: ctx}
			command := shellTestCommand("Start-Sleep -Seconds 30", "ping -n 31 127.0.0.1 >NUL", "sleep 30")
			target := bashStartTool(t.TempDir())
			args := map[string]any{"command": command, "timeout_ms": 3600000}
			if name != "start" {
				s, err := startBashSession(t.TempDir(), command, owner)
				if err != nil {
					t.Fatal(err)
				}
				args = map[string]any{"session_id": s.id, "timeout_ms": 3600000, "quiet_ms": 60000}
				target = bashWaitTool()
				if name == "stdin" {
					target = bashStdinTool()
					args = map[string]any{"session_id": s.id, "input": "echo queued", "timeout_ms": 3600000}
				}
			}
			finished := make(chan error, 1)
			go func() {
				_, err := target.(runnableShellTool).Run(toolCtx, args)
				finished <- err
			}()
			s := waitForOwnedShell(t, owner)
			// Allow the tool to enter the hour-long wait before cancelling.
			time.Sleep(50 * time.Millisecond)
			started := time.Now()
			cancel()
			select {
			case err := <-finished:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("tool error = %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("tool kept waiting after cancellation")
			}
			requireShellExited(t, s)
			t.Logf("cancelled %s and its process in %s", name, time.Since(started))
		})
	}
}

func TestCancelledContextCannotStartInteractiveShell(t *testing.T) {
	owner := testSessionOwner("cancel-before-start")
	ctx, cancel := context.WithCancel(WithSessionOwner(t.Context(), owner))
	cancel()
	t.Cleanup(func() { BashSessionTerminate("", owner) })
	_, err := bashStartTool(t.TempDir()).(runnableShellTool).Run(cancellableShellContext{base: ctx},
		map[string]any{"command": "echo must-not-run", "timeout_ms": 100})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("tool error = %v", err)
	}
	if shells := BashSessionsSnapshot(owner); len(shells) != 0 {
		t.Fatalf("cancelled tool started processes: %v", shells)
	}
}

func TestCompletedStartDoesNotBindShellLifetimeToTurn(t *testing.T) {
	owner := testSessionOwner("completed-start")
	ctx, cancel := context.WithCancel(WithSessionOwner(t.Context(), owner))
	defer cancel()
	t.Cleanup(func() { BashSessionTerminate("", owner) })
	result, err := bashStartTool(t.TempDir()).(runnableShellTool).Run(cancellableShellContext{base: ctx},
		map[string]any{"command": "echo persistent-shell", "timeout_ms": 100})
	if err != nil {
		t.Fatal(err)
	}
	s, ok := findBashSession(result["sessionId"].(string), owner)
	if !ok {
		t.Fatal("started shell missing")
	}
	cancel() // Normal turn completion also releases its context.
	select {
	case <-s.done:
		t.Fatal("normal turn cleanup killed its persistent shell")
	case <-time.After(100 * time.Millisecond):
	}
	if err := s.stop(); err != nil {
		t.Fatal(err)
	}
	requireShellExited(t, s)
}

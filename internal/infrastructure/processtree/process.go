// Package processtree owns a command and its descendants as one lifetime.
package processtree

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
)

type Tree struct {
	mu   sync.Mutex
	kill func() error
}

// Kill is safe to call concurrently and after the command has already exited.
func (t *Tree) Kill() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.kill == nil {
		return nil
	}
	if err := t.kill(); err != nil {
		return err
	}
	t.kill = nil
	return nil
}

// CombinedOutput also cleans up descendants on normal exit and context cancellation.
func CombinedOutput(cmd *exec.Cmd) ([]byte, error) {
	var output bytes.Buffer
	err := CombinedOutputTo(cmd, &output)
	return output.Bytes(), err
}

// CombinedOutputTo streams stdout and stderr to dst while keeping the same
// process-tree cleanup guarantees as CombinedOutput.
func CombinedOutputTo(cmd *exec.Cmd, dst io.Writer) error {
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	cmd.Stdout, cmd.Stderr = writer, writer
	tree, err := Start(cmd)
	writer.Close()
	if err != nil {
		return err
	}
	defer tree.Kill()
	readDone := make(chan error, 1)
	go func() {
		_, err := io.Copy(dst, reader)
		readDone <- err
	}()
	waitErr := cmd.Wait()
	killErr := tree.Kill()
	if killErr != nil {
		reader.Close()
	}
	readErr := <-readDone
	return errors.Join(waitErr, killErr, readErr)
}

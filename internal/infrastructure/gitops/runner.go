// Package gitops 通过外部调用 git CLI，复现 Java 端
// GitService / SnapshotService / WorktreeService 的命令序列。
package gitops

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/hideconsole"
)

// 各超时值与 Java GitCommandRunner 的调用点保持一致：查询 10 秒，
// push 60 秒，快照 15 秒，工作树操作 180 秒。
const (
	TimeoutQuery    = 10 * time.Second
	TimeoutPush     = 60 * time.Second
	TimeoutSnapshot = 15 * time.Second
	TimeoutWorktree = 180 * time.Second
)

// maxStream 与 Java 调用方一致，将每路捕获输出限制在 10 MB。
const maxStream = 10 << 20

const truncatedSuffix = "\n... (Git output truncated)"

// RunError 描述一次失败的 git 调用，并保留两路输出流。
type RunError struct {
	Args     []string
	Stdout   string
	Stderr   string
	ExitCode int
	TimedOut bool
}

func (e *RunError) Error() string {
	if e.TimedOut {
		return fmt.Sprintf("git %s: command timed out", strings.Join(e.Args, " "))
	}
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = fmt.Sprintf("exit status %d", e.ExitCode)
	}
	return fmt.Sprintf("git %s: %s", strings.Join(e.Args, " "), msg)
}

// Runner 在单个工作目录中执行 git。
type Runner struct {
	Dir string
	Env []string
}

// Git 带超时执行 git；GIT_TERMINAL_PROMPT=0 关闭交互提示，
// 每路输出流在 10 MB 处截断。
func (rn Runner) Git(timeout time.Duration, args ...string) (stdout, stderr string, err error) {
	if timeout <= 0 {
		timeout = TimeoutQuery
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	hideconsole.Apply(cmd)
	cmd.Dir = rn.Dir
	cmd.Env = append(append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0"), rn.Env...)
	var out, errBuf limitBuffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	runErr := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return out.String(), errBuf.String(), &RunError{Args: args, Stdout: out.String(),
			Stderr: "Command timed out", ExitCode: -1, TimedOut: true}
	}
	if runErr != nil {
		re := &RunError{Args: args, Stdout: out.String(), Stderr: errBuf.String()}
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			re.ExitCode = exitErr.ExitCode()
		} else {
			re.Stderr = runErr.Error()
		}
		return out.String(), errBuf.String(), re
	}
	return out.String(), errBuf.String(), nil
}

// Line 执行 git 并返回去除首尾空白的 stdout（失败时返回 "" 与错误）。
func (rn Runner) Line(timeout time.Duration, args ...string) (string, error) {
	out, _, err := rn.Git(timeout, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// limitBuffer 限制捕获输出的大小，并追加截断标记。
type limitBuffer struct {
	buf  bytes.Buffer
	over bool
}

func (b *limitBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.buf.Len()+n > maxStream {
		keep := maxStream - b.buf.Len()
		if keep > 0 {
			b.buf.Write(p[:keep])
		}
		b.over = true
	} else {
		b.buf.Write(p)
	}
	return n, nil
}

func (b *limitBuffer) String() string {
	if b.over {
		return b.buf.String() + truncatedSuffix
	}
	return b.buf.String()
}

// Available 报告是否能执行 git 可执行文件。
func Available() bool {
	_, _, err := Runner{Dir: "."}.Git(TimeoutQuery, "--version")
	return err == nil
}

// IsRepo 报告 dir 是否位于 git 工作树内。
func IsRepo(dir string) bool {
	_, _, err := Runner{Dir: dir}.Git(TimeoutQuery, "rev-parse", "--is-inside-work-tree")
	return err == nil
}

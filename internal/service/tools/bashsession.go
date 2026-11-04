package tools

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/infrastructure/processtree"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

// bashSession 是工具集背后一个长驻交互 shell：
// 输出累积到有上限的日志中，使 wait 能返回增量，
// 面板端点也能重放完整历史。
type bashSession struct {
	id      string
	owner   SessionOwner
	command string
	workdir string
	started time.Time

	mu     sync.Mutex
	log    bytes.Buffer
	wakeup chan struct{}
	done   chan struct{}
	proc   *exec.Cmd
	tree   *processtree.Tree
	shell  shellenv.Shell
	stdin  io.WriteCloser
	status string // 取值：running | completed | failed | stopped
}

const bashLogCap = 1 << 20 // 1 MB 滚动上限

var (
	bashMu       sync.Mutex
	bashSessions = map[string]*bashSession{}
)

// belongsTo 对完整会话标识匹配；零值表示全局管理视图。
func (s *bashSession) belongsTo(owner SessionOwner) bool {
	return owner == (SessionOwner{}) || s.owner == owner
}

func findBashSession(id string, owner SessionOwner) (*bashSession, bool) {
	bashMu.Lock()
	s, ok := bashSessions[id]
	bashMu.Unlock()
	// Ownership is fixed when the process starts; output and status use s.mu.
	if !ok || !s.belongsTo(owner) {
		return nil, false
	}
	return s, true
}

// BashSessionsSnapshot 列出 /api/agent 接口使用的活跃面板，
// 按启动时间升序（最新的排在后面，由调用方决定展示顺序）。
// owner 非零时只返回该项目、该会话启动的进程。
func BashSessionsSnapshot(owner SessionOwner) []map[string]any {
	bashMu.Lock()
	defer bashMu.Unlock()
	out := make([]map[string]any, 0, len(bashSessions))
	for _, s := range bashSessions {
		s.mu.Lock()
		if s.belongsTo(owner) {
			out = append(out, map[string]any{
				"sessionId": s.id, "owner": s.owner.Session, "workspaceHash": s.owner.Workspace,
				"workspace": s.workdir, "command": s.command,
				"workdir": s.workdir, "startedAt": s.started.UnixMilli(), "status": s.status,
			})
		}
		s.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["startedAt"].(int64) < out[j]["startedAt"].(int64)
	})
	return out
}

// BashSessionLog 返回某个会话累积的输出。
func BashSessionLog(id string, owner SessionOwner) (string, bool) {
	entry, ok := BashSessionEntry(id, owner)
	if !ok {
		return "", false
	}
	output, _ := entry["output"].(string)
	return output, true
}

// BashSessionEntry 返回某个会话的完整面板视图；
// owner 非零时只解析归属该项目、该会话的进程。
func BashSessionEntry(id string, owner SessionOwner) (map[string]any, bool) {
	s, ok := findBashSession(id, owner)
	if !ok {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{
		"sessionId": s.id, "owner": s.owner.Session, "workspaceHash": s.owner.Workspace,
		"workspace": s.workdir, "command": s.command,
		"workdir": s.workdir, "startedAt": s.started.UnixMilli(),
		"status": s.status, "output": s.log.String(),
	}, true
}

// BashSessionTerminate 终止一个会话（"" 表示终止查询范围内的全部），
// 并立即将其从注册表中移除。owner 非零时只影响归属该项目、该会话的进程。
func BashSessionTerminate(id string, owner SessionOwner) int {
	bashMu.Lock()
	var targets []*bashSession
	if id == "" {
		for _, s := range bashSessions {
			if s.belongsTo(owner) {
				targets = append(targets, s)
			}
		}
	} else if s, ok := bashSessions[id]; ok {
		if s.belongsTo(owner) {
			targets = append(targets, s)
		}
	}
	bashMu.Unlock()
	n := 0
	for _, s := range targets {
		if err := s.stop(); err != nil {
			continue
		}
		bashMu.Lock()
		delete(bashSessions, s.id)
		bashMu.Unlock()
		n++
	}
	return n
}

func (s *bashSession) appendLog(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.log.Len()+len(p) > bashLogCap {
		// 保留尾部内容
		kept := s.log.Bytes()
		drop := s.log.Len() + len(p) - bashLogCap
		if drop < 0 {
			drop = 0
		}
		if drop > len(kept) {
			drop = len(kept)
		}
		s.log.Reset()
		s.log.Write(kept[drop:])
	}
	s.log.Write(p)
	select {
	case s.wakeup <- struct{}{}:
	default:
	}
}

func (s *bashSession) setStatus(status string) {
	s.mu.Lock()
	if s.status != "stopped" { // 用户主动停止不能被退出路径覆盖
		s.status = status
	}
	s.mu.Unlock()
	select {
	case s.wakeup <- struct{}{}:
	default:
	}
}

func (s *bashSession) stop() error {
	if s.tree != nil {
		if err := s.tree.Kill(); err != nil {
			return err
		}
	}
	if s.stdin != nil {
		s.stdin.Close()
	}
	s.setStatus("stopped")
	return nil
}

// wait 返回 mark 之后产生的输出，直到输出流静默 quietMs
// 或总截止时间到达。
func (s *bashSession) wait(mark int, quietMs, deadlineMs int) string {
	out, _ := s.waitContext(context.Background(), mark, quietMs, deadlineMs)
	return out
}

func (s *bashSession) waitContext(ctx context.Context, mark int, quietMs, deadlineMs int) (string, error) {
	stopCancel := context.AfterFunc(ctx, func() { _ = s.stop() })
	defer stopCancel()
	if quietMs <= 0 {
		quietMs = 1200
	}
	if deadlineMs <= 0 {
		deadlineMs = 10000
	}
	deadline := time.Now().Add(time.Duration(deadlineMs) * time.Millisecond)
	quiet := time.Duration(quietMs) * time.Millisecond
	from := mark
	last := time.Now()
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return "", errors.Join(err, s.stop())
		}
		s.mu.Lock()
		logged := s.log.Len()
		s.mu.Unlock()
		if logged > mark {
			last = time.Now()
			mark = logged
		}
		if time.Since(last) >= quiet {
			break
		}
		select {
		case <-ctx.Done():
			return "", errors.Join(ctx.Err(), s.stop())
		case <-s.wakeup:
		case <-s.done:
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.logSlice(from), ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logSlice(from), ctx.Err()
}

// logSlice 返回从字节偏移 from 开始的日志（会收敛到有效范围）；
// 调用方必须持有 s.mu。
func (s *bashSession) logSlice(from int) string {
	if from < 0 || from >= s.log.Len() {
		return ""
	}
	return s.log.String()[from:]
}

func (s *bashSession) mark() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.log.Len()
}

func startBashSession(root, command string, owner SessionOwner) (*bashSession, error) {
	return startShellSession(root, command, owner, shellenv.Current)
}

func startShellSession(root, command string, owner SessionOwner, shell shellenv.Shell) (*bashSession, error) {
	return startShellSessionContext(context.Background(), root, command, owner, shell)
}

func startShellSessionContext(ctx context.Context, root, command string, owner SessionOwner, shell shellenv.Shell) (*bashSession, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := shell.InteractiveCommand()
	cmd.Dir = root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, writer, err := os.Pipe()
	if err != nil {
		stdin.Close()
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = writer, writer
	tree, err := processtree.Start(cmd)
	writer.Close()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return nil, err
	}
	s := &bashSession{
		id: newBashID(), owner: owner, command: command, workdir: root, started: time.Now(),
		wakeup: make(chan struct{}, 1), done: make(chan struct{}), proc: cmd, tree: tree, shell: shell, stdin: stdin,
		status: "running",
	}
	// 面板是进程级的注册表，条目落在启动它的会话名下，
	// 这样其它会话/项目看不到也杀不掉它。
	bashMu.Lock()
	bashSessions[s.id] = s
	bashMu.Unlock()
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		defer stdout.Close()
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				s.appendLog(buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()
	go func() {
		err := cmd.Wait()
		// A shell that exits normally must not leave background children behind.
		if killErr := tree.Kill(); killErr != nil {
			stdout.Close()
			err = killErr
		}
		stdin.Close()
		<-outputDone
		if err != nil {
			s.setStatus("failed")
		} else {
			s.setStatus("completed")
		}
		close(s.done)
		// 完成后保留面板条目 60 秒（与 Java 端 TTL 一致）
		time.AfterFunc(60*time.Second, func() {
			bashMu.Lock()
			delete(bashSessions, s.id)
			bashMu.Unlock()
		})
	}()
	// Cancellation must also unblock a large stdin write while the shell is busy.
	// Disarm on return: a successfully started shell may outlive this turn.
	stopCancel := context.AfterFunc(ctx, func() { _ = s.stop() })
	defer stopCancel()
	if err := ctx.Err(); err != nil {
		_ = s.stop()
		return nil, err
	}
	// 投递启动命令
	if _, err := io.WriteString(stdin, shell.InitializeInput()+shell.Input(command)); err != nil {
		BashSessionTerminate(s.id, owner)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		_ = s.stop()
		return nil, err
	}
	return s, nil
}

var bashCounter int64

func newBashID() string {
	bashMu.Lock()
	defer bashMu.Unlock()
	bashCounter++
	buf := make([]byte, 4)
	if _, err := cryptorand.Read(buf); err != nil {
		return fmt.Sprintf("%s-%d", shellenv.Current.Name, bashCounter)
	}
	return fmt.Sprintf("%s-%d-%s", shellenv.Current.Name, bashCounter, hex.EncodeToString(buf))
}

// BashTools 构建作用域限定在 root 的交互 shell 四件套。
func BashTools(root string) []Tool {
	name := shellenv.Current.Name
	return []Tool{
		{bashStartTool(root), Metadata{Name: name + "_start", Description: "启动长驻交互 " + name + " 会话并执行首条命令（支持 cwd、max_char、timeout）", ReadOnly: false, AutoApprove: false}},
		{bashWaitTool(), Metadata{Name: name + "_wait", Description: "等待交互 " + name + " 会话产出新输出（支持 max_char、timeout）", ReadOnly: true, AutoApprove: true}},
		{bashStdinTool(), Metadata{Name: name + "_stdin", Description: "向交互 " + name + " 会话写入输入（支持 max_char、timeout）", ReadOnly: false, AutoApprove: false}},
		{bashStopTool(), Metadata{Name: name + "_stop", Description: "终止交互 " + name + " 会话及其子进程", ReadOnly: false, AutoApprove: true}},
	}
}

type bashStartInput struct {
	Command   string `json:"command" jsonschema:"要在交互会话中执行的首条命令"`
	Cwd       string `json:"cwd,omitempty" jsonschema:"工作目录，默认项目根；相对路径按项目根解析，也接受项目外的绝对路径"`
	Workdir   string `json:"workdir,omitempty" jsonschema:"兼容旧参数：相对工作目录；与 cwd 同时提供时以 cwd 为准"`
	MaxChar   int    `json:"max_char,omitempty" jsonschema:"最多返回的字符数，默认 8000，最大 200000"`
	Timeout   int    `json:"timeout,omitempty" jsonschema:"等待首屏输出的超时秒数，默认 8，最大 3600；不会终止会话"`
	TimeoutMs int    `json:"timeout_ms,omitempty" jsonschema:"兼容旧参数：等待首屏输出的超时毫秒数；与 timeout 同时提供时以 timeout 为准"`
}

func bashStartTool(root string) tool.Tool {
	t, _ := functiontool.New[bashStartInput, map[string]any](
		functiontool.Config{Name: shellenv.Current.Name + "_start", Description: "启动长驻交互 " + shellenv.Current.Name + " 会话，使用该 shell 的语法；支持 cwd、max_char、timeout 参数"},
		func(ctx agentpkg.Context, in bashStartInput) (map[string]any, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			maxChars, err := normalizeShellMaxChars(in.MaxChar, defaultInteractiveMaxChars)
			if err != nil {
				return nil, err
			}
			waitTimeout, err := normalizeTimeout(in.Timeout, in.TimeoutMs, 8*time.Second)
			if err != nil {
				return nil, err
			}
			cwd := in.Cwd
			if cwd == "" {
				cwd = in.Workdir
			}
			dir, err := resolveShellCwd(ctx, root, cwd)
			if err != nil {
				return nil, err
			}
			s, err := startShellSessionContext(ctx, dir, in.Command, sessionOwner(ctx), shellenv.Current)
			if err != nil {
				return nil, err
			}
			out, err := s.waitContext(ctx, 0, 1500, int(waitTimeout/time.Millisecond))
			if err != nil {
				return nil, err
			}
			result := shellOutputResult(out, maxChars)
			result["sessionId"] = s.id
			result["status"] = s.statusLocked()
			result["cwd"] = dir
			return result, nil
		})
	return t
}

type bashWaitInput struct {
	SessionID string `json:"session_id" jsonschema:"启动工具返回的会话 ID"`
	QuietMs   int    `json:"quiet_ms,omitempty" jsonschema:"输出静默判定毫秒数，默认 1200"`
	MaxChar   int    `json:"max_char,omitempty" jsonschema:"最多返回的字符数，默认 8000，最大 200000"`
	Timeout   int    `json:"timeout,omitempty" jsonschema:"最长等待秒数，默认 10，最大 3600；不会终止会话"`
	TimeoutMs int    `json:"timeout_ms,omitempty" jsonschema:"兼容旧参数：最长等待毫秒数；与 timeout 同时提供时以 timeout 为准"`
}

func bashWaitTool() tool.Tool {
	t, _ := functiontool.New[bashWaitInput, map[string]any](
		functiontool.Config{Name: shellenv.Current.Name + "_wait", Description: "等待交互 " + shellenv.Current.Name + " 会话产出新输出；支持 max_char、timeout 参数"},
		func(ctx agentpkg.Context, in bashWaitInput) (map[string]any, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			maxChars, err := normalizeShellMaxChars(in.MaxChar, defaultInteractiveMaxChars)
			if err != nil {
				return nil, err
			}
			waitTimeout, err := normalizeTimeout(in.Timeout, in.TimeoutMs, 10*time.Second)
			if err != nil {
				return nil, err
			}
			// 只允许操作本会话启动的进程：注册表是进程级共享的。
			s, ok := findBashSession(in.SessionID, sessionOwner(ctx))
			if !ok {
				return nil, fmt.Errorf("会话不存在: %s", in.SessionID)
			}
			out, err := s.waitContext(ctx, s.mark(), in.QuietMs, int(waitTimeout/time.Millisecond))
			if err != nil {
				return nil, err
			}
			result := shellOutputResult(out, maxChars)
			result["status"] = s.statusLocked()
			return result, nil
		})
	return t
}

func (s *bashSession) statusLocked() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

type bashStdinInput struct {
	SessionID string `json:"session_id" jsonschema:"目标会话 ID"`
	Input     string `json:"input" jsonschema:"要写入的一行输入"`
	MaxChar   int    `json:"max_char,omitempty" jsonschema:"最多返回的字符数，默认 8000，最大 200000"`
	Timeout   int    `json:"timeout,omitempty" jsonschema:"等待输出的超时秒数，默认 8，最大 3600；不会终止会话"`
	TimeoutMs int    `json:"timeout_ms,omitempty" jsonschema:"兼容旧参数：等待输出的超时毫秒数；与 timeout 同时提供时以 timeout 为准"`
}

func bashStdinTool() tool.Tool {
	t, _ := functiontool.New[bashStdinInput, map[string]any](
		functiontool.Config{Name: shellenv.Current.Name + "_stdin", Description: "向交互 " + shellenv.Current.Name + " 会话写入输入；支持 max_char、timeout 参数"},
		func(ctx agentpkg.Context, in bashStdinInput) (map[string]any, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			maxChars, err := normalizeShellMaxChars(in.MaxChar, defaultInteractiveMaxChars)
			if err != nil {
				return nil, err
			}
			waitTimeout, err := normalizeTimeout(in.Timeout, in.TimeoutMs, 8*time.Second)
			if err != nil {
				return nil, err
			}
			s, ok := findBashSession(in.SessionID, sessionOwner(ctx))
			if !ok {
				return nil, fmt.Errorf("会话不存在: %s", in.SessionID)
			}
			mark := s.mark()
			stopCancel := context.AfterFunc(ctx, func() { _ = s.stop() })
			defer stopCancel()
			if _, err := io.WriteString(s.stdin, s.shell.Input(in.Input)); err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, err
			}
			out, err := s.waitContext(ctx, mark, 1200, int(waitTimeout/time.Millisecond))
			if err != nil {
				return nil, err
			}
			return shellOutputResult(out, maxChars), nil
		})
	return t
}

func bashStopTool() tool.Tool {
	t, _ := functiontool.New[struct {
		SessionID string `json:"session_id" jsonschema:"要终止的会话 ID"`
	}, map[string]any](functiontool.Config{Name: shellenv.Current.Name + "_stop", Description: "终止交互 " + shellenv.Current.Name + " 会话及其子进程"},
		func(ctx agentpkg.Context, in struct {
			SessionID string `json:"session_id" jsonschema:"要终止的会话 ID"`
		}) (map[string]any, error) {
			s, ok := findBashSession(in.SessionID, sessionOwner(ctx))
			if !ok {
				return nil, fmt.Errorf("会话不存在: %s", in.SessionID)
			}
			if err := s.stop(); err != nil {
				return nil, fmt.Errorf("终止会话进程树失败: %w", err)
			}
			return map[string]any{"result": "已终止会话: " + in.SessionID}, nil
		})
	return t
}

const defaultInteractiveMaxChars = 8000

func shellOutputResult(s string, maxChars int) map[string]any {
	s = strings.TrimRight(s, " \r\n")
	if s == "" {
		return map[string]any{
			"result": "(暂无输出)", "truncated": false,
			"max_char": maxChars, "total_chars": 0,
		}
	}
	runes := []rune(s)
	total := len(runes)
	truncated := total > maxChars
	if truncated {
		s = string(runes[:maxChars]) + fmt.Sprintf("\n\n[输出已截断：仅保留前 %d 个字符，共 %d 个字符；可增大 max_char]", maxChars, total)
	}
	result := map[string]any{
		"result": s, "truncated": truncated,
		"max_char": maxChars, "total_chars": total,
	}
	if truncated {
		result["omitted_chars"] = total - maxChars
	}
	return result
}

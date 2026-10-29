package acp

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/infrastructure/processtree"
)

// 进程退出后的错误，供上层映射成前端文案。
var (
	ErrClosed = errors.New("ACP 连接已关闭")
	ErrExited = errors.New("ACP Agent 已退出，请检查对应 Agent 的登录状态和配置后重试")
	ErrBroken = errors.New("ACP Agent 通信中断，请检查对应 Agent 的登录状态和配置")
)

// agentProcess 拉起外部 ACP 进程。协议读写交给 coder/acp-go-sdk，
// 这里只负责进程、环境变量和退出回收。
type agentProcess struct {
	cmd    *exec.Cmd
	tree   *processtree.Tree
	stdin  io.WriteCloser
	stdout io.ReadCloser

	mu     sync.Mutex
	closed bool
	exited bool
}

func startAgentProcess(command []string, env map[string]string, dir string) (*agentProcess, error) {
	if len(command) == 0 {
		return nil, fmt.Errorf("ACP 启动命令为空")
	}
	extra := make([]string, 0, len(env))
	for key, value := range env {
		extra = append(extra, key+"="+value)
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), childEnv(extra)...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("启动 ACP Agent 失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("启动 ACP Agent 失败: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("启动 ACP Agent 失败: %w", err)
	}
	tree, err := processtree.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("启动 ACP Agent 失败: %w", err)
	}
	proc := &agentProcess{cmd: cmd, tree: tree, stdin: stdin, stdout: stdout}
	if proxy := envValue("HTTPS_PROXY"); proxy != "" || envValue("HTTP_PROXY") != "" || envValue("https_proxy") != "" || envValue("http_proxy") != "" {
		logging.Warnf("acp", "proxy detected; loopback bypass NO_PROXY=%s", withLoopbackHosts(envValue("NO_PROXY")))
	}
	logging.Infof("acp", "started pid=%d cwd=%s cmd=%s", cmd.Process.Pid, dir, commandLine(command))
	go drain(stderr)
	go proc.wait()
	return proc, nil
}

func (p *agentProcess) wait() {
	err := p.cmd.Wait()
	p.mu.Lock()
	p.exited = true
	p.mu.Unlock()
	if err != nil {
		logging.Debugf("acp", "agent process exited: %v", err)
	}
}

func (p *agentProcess) Alive() bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.closed && !p.exited
}

func (p *agentProcess) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	stdin := p.stdin
	tree := p.tree
	p.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if tree != nil {
		_ = tree.Kill()
	}
	return nil
}

// childEnv 组装子进程环境：在提供方覆盖项之外，强制把本机回环地址
// 加入 NO_PROXY。否则从 IDE/桌面继承来的 HTTP(S)_PROXY 会把 Agent 发往
// 本机推理网关（如 127.0.0.1:3425）的请求也转给代理，代理无法访问用户
// 本机，通常返回 502（no body）。
func childEnv(extra []string) []string {
	merged := append([]string(nil), extra...)
	noProxy := envValue("NO_PROXY")
	if noProxy == "" {
		noProxy = envValue("no_proxy")
	}
	noProxy = withLoopbackHosts(noProxy)
	// Windows 的环境变量名不区分大小写，Unix 需要两种拼写都设置。
	return append(merged, "NO_PROXY="+noProxy, "no_proxy="+noProxy)
}

// withLoopbackHosts 把回环地址合并进 NO_PROXY 列表。
func withLoopbackHosts(noProxy string) string {
	if strings.TrimSpace(noProxy) == "*" {
		return noProxy
	}
	seen := map[string]bool{}
	entries := []string{}
	for _, entry := range strings.Split(noProxy, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		seen[strings.ToLower(entry)] = true
		entries = append(entries, entry)
	}
	for _, host := range []string{"127.0.0.1", "localhost", "::1"} {
		if !seen[host] {
			seen[host] = true
			entries = append(entries, host)
		}
	}
	return strings.Join(entries, ",")
}

// commandLine 渲染启动命令；DSH 的 --import data URL 很长，截断避免刷屏。
func commandLine(command []string) string {
	line := strings.Join(command, " ")
	if len(line) > 240 {
		return line[:240] + "…"
	}
	return line
}

func drain(r io.Reader) {
	_, _ = io.Copy(io.Discard, r)
}

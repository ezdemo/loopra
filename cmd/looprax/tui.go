package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/charmbracelet/x/term"

	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/microacp"
)

func runTUI(ctx context.Context, options config.Options) (runErr error) {
	if !term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd()) {
		return fmt.Errorf("loopra tui requires an interactive terminal")
	}
	settings, err := config.Load(ctx, options)
	if err != nil {
		return err
	}
	executable, cleanup, err := resolveTUIClient()
	if err != nil {
		return err
	}
	if cleanup != nil {
		defer func() { runErr = errors.Join(runErr, cleanup()) }()
	}
	return runMicroACP(ctx, executable, settings.Home, options.ConfigFile)
}

func resolveTUIClient() (executable string, cleanup func() error, err error) {
	if microacp.Available() {
		return microacp.Stage()
	}
	executable, err = exec.LookPath("micro-acp")
	if err != nil {
		return "", nil, fmt.Errorf("loopra tui: no bundled micro-acp for this platform; install it on PATH: %w", err)
	}
	return executable, nil, nil
}

const microACPAgentName = "Loopra"

// micro-acp 启动同一可执行文件的 acp 子命令，并直接继承当前终端与工作目录。
// 通过生成的命名 custom agent 启动，避免界面把内联命令显示成 custom-<hash>。
func runMicroACP(ctx context.Context, executable, home, configFile string) (runErr error) {
	loopra, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Loopra executable: %w", err)
	}
	agentArgs := []string{"acp", "--home", home}
	if configFile != "" {
		agentArgs = append(agentArgs, "--config", configFile)
	}
	launchConfig, cleanup, err := writeMicroACPLaunchConfig(home, loopra, agentArgs)
	if err != nil {
		return err
	}
	defer func() { runErr = errors.Join(runErr, cleanup()) }()

	cmd := exec.CommandContext(ctx, executable, microACPArgs(launchConfig)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "MICRO_ACP_HOME="+filepath.Join(home, "micro-acp"))
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("run micro-acp: %w", err)
	}
	return nil
}

func microACPArgs(launchConfig string) []string {
	return []string{"--offline", "--config", launchConfig, "--agent", microACPAgentName}
}

// writeMicroACPLaunchConfig 生成一次启动使用的 micro-acp 配置。默认配置里的
// MCP、附加目录和其他 custom agent 会合并进来，但不会被改写。
func writeMicroACPLaunchConfig(home, loopra string, agentArgs []string) (path string, cleanup func() error, err error) {
	data, err := microACPConfigJSON(filepath.Join(home, "micro-acp", "config.json"), loopra, agentArgs)
	if err != nil {
		return "", nil, err
	}
	dir, err := os.MkdirTemp("", "loopra-micro-acp-config-")
	if err != nil {
		return "", nil, fmt.Errorf("create micro-acp config directory: %w", err)
	}
	cleanupDir := func() error { return os.RemoveAll(dir) }
	defer func() {
		if err != nil {
			err = errors.Join(err, cleanupDir())
		}
	}()
	path = filepath.Join(dir, "config.json")
	if err = os.WriteFile(path, data, 0o600); err != nil {
		return "", nil, fmt.Errorf("write micro-acp launch config: %w", err)
	}
	return path, cleanupDir, nil
}

func microACPConfigJSON(baseConfig, loopra string, agentArgs []string) ([]byte, error) {
	obj := map[string]any{}
	data, err := os.ReadFile(baseConfig)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &obj); err != nil {
			return nil, fmt.Errorf("parse micro-acp config %s: %w", baseConfig, err)
		}
		if obj == nil {
			obj = map[string]any{}
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, fmt.Errorf("read micro-acp config %s: %w", baseConfig, err)
	}

	agents := map[string]any{}
	if raw, ok := obj["agents"]; ok && raw != nil {
		existing, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("micro-acp config %s agents must be an object", baseConfig)
		}
		for name, command := range existing {
			agents[name] = command
		}
	}
	entry := map[string]any{}
	if existing, ok := agents[microACPAgentName].(map[string]any); ok {
		for key, value := range existing {
			entry[key] = value
		}
	}
	entry["command"] = loopra
	entry["args"] = agentArgs
	agents[microACPAgentName] = entry
	obj["agents"] = agents

	out, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode micro-acp launch config: %w", err)
	}
	return append(out, '\n'), nil
}

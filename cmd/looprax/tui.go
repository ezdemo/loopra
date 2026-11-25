package main

import (
	"context"
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
		return "", nil, fmt.Errorf("loopra tui: this build does not bundle micro-acp; install it on PATH or use a Loopra release with micro-acp bundled: %w", err)
	}
	return executable, nil, nil
}

// micro-acp 启动同一可执行文件的 acp 子命令，并直接继承当前终端与工作目录。
func runMicroACP(ctx context.Context, executable, home, configFile string) error {
	loopra, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Loopra executable: %w", err)
	}
	args := []string{"--offline", "--", loopra, "acp", "--home", home}
	if configFile != "" {
		args = append(args, "--config", configFile)
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "MICRO_ACP_HOME="+filepath.Join(home, "micro-acp"))
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("run micro-acp: %w", err)
	}
	return nil
}

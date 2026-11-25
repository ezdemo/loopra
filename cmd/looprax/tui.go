package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/charmbracelet/x/term"

	"github.com/ezdemo/looprax/internal/acpserver"
	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/microacp"
	"github.com/ezdemo/looprax/internal/tui"
)

func runTUI(ctx context.Context, options config.Options) error {
	if !term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd()) {
		return fmt.Errorf("loopra tui requires an interactive terminal")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("resolve working directory: %w", err)
	}
	settings, err := config.Load(ctx, options)
	if err != nil {
		return err
	}
	if microacp.Available() {
		return runBundledTUI(ctx, settings.Home, options.ConfigFile)
	}
	runtime, err := acpserver.Open(ctx, settings)
	if err != nil {
		return err
	}
	return tui.Run(ctx, runtime, cwd, os.Stdin, os.Stdout)
}

// 打包构建内嵌官方 micro-acp 客户端，解包后由它启动同一可执行文件的
// `acp` 子命令。micro-acp 直接继承终端与当前目录，保持前台 TTY 控制权。
func runBundledTUI(ctx context.Context, home, configFile string) (runErr error) {
	loopra, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Loopra executable: %w", err)
	}
	executable, cleanup, err := microacp.Stage()
	if err != nil {
		return err
	}
	defer func() { runErr = errors.Join(runErr, cleanup()) }()
	args := []string{"--offline", "--", loopra, "acp", "--home", home}
	if configFile != "" {
		args = append(args, "--config", configFile)
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "MICRO_ACP_HOME="+filepath.Join(home, "micro-acp"))
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("run bundled micro-acp: %w", err)
	}
	return nil
}

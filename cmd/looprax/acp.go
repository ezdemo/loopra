package main

import (
	"context"
	"os"

	"github.com/ezdemo/looprax/internal/acpserver"
	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

func runACP(ctx context.Context, options config.Options) error {
	logging.UseWriter(os.Stderr)
	// 协议走 stdout。默认标准错误只留 ACP；LOOPRA_DEBUG=1 时恢复全部日志。
	if !logging.DebugEnabled() {
		logging.OnlyTags("acp")
		logging.DiscardLibraries()
	}
	settings, err := config.Load(ctx, options)
	if err != nil {
		return err
	}
	runtime, err := acpserver.Open(ctx, settings)
	if err != nil {
		return err
	}
	return acpserver.Serve(ctx, runtime)
}

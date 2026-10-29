// Command loopra 启动 Loopra 兼容的 GoFrame 后端。
//
// 用法与 Spring Boot 的可执行 jar 对齐：命令行参数 > 环境变量 > manifest/config/config.yaml。
// 不写子命令时默认启动 web。
//
//	loopra
//	loopra [web] [port] [flags]
//	loopra acp [flags]
//	loopra --config manifest/config/config.yaml --port 4567
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/ezdemo/looprax/internal/bootstrap"
	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

const (
	commandWeb = "web"
	commandACP = "acp"
)

type invocation struct {
	Command string
	Options config.Options
}

// errUsage 表示参数个数不对。用法已经打印过，调用方只需以状态码 2 退出。
var errUsage = errors.New("invalid arguments")

func main() {
	parsed, err := parseArgs(os.Args[1:], os.Stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	quietWeb := parsed.Command != commandACP && !logging.DebugEnabled()
	if quietWeb {
		logging.Suppress()
	}
	var runErr error
	if parsed.Command == commandACP {
		runErr = runACP(ctx, parsed.Options)
	} else {
		runErr = bootstrap.Run(ctx, parsed.Options)
	}
	if runErr != nil {
		if quietWeb {
			fmt.Fprintf(os.Stderr, "%v\n", runErr)
		} else {
			tag := "server"
			if parsed.Command == commandACP {
				tag = "acp"
			}
			logging.Errorf(tag, "%v", runErr)
		}
		os.Exit(1)
	}
}

// parseArgs 解析启动参数。不写子命令时启动 web。
// web 的端口可以写在子命令后面，也可以单独作为位置参数，或用 --port 指定。
// acp 在标准输入输出上提供 ACP 服务，不使用端口。
func parseArgs(args []string, output io.Writer) (invocation, error) {
	var options config.Options
	fs := flag.NewFlagSet("loopra", flag.ContinueOnError)
	fs.SetOutput(output)
	fs.Usage = func() {
		fmt.Fprintln(output, "usage: loopra [web] [port] [flags]")
		fmt.Fprintln(output, "       loopra acp [flags]")
		fs.PrintDefaults()
	}
	fs.StringVar(&options.ConfigFile, "config", "", "配置文件路径（默认 manifest/config/config.yaml）")
	fs.StringVar(&options.Home, "home", "", "应用数据目录（默认 ~/.loopra）")
	fs.StringVar(&options.Port, "port", "", "HTTP 端口（未指定时由系统分配空闲端口）")
	fs.StringVar(&options.AccessKey, "access-key", "", "访问密钥（默认启动时生成）")
	fs.StringVar(&options.StaticDir, "static-dir", "", "前端目录（默认使用自行编译的 web/dist，或嵌进二进制的页面）")
	fs.StringVar(&options.PetsDir, "pets-dir", "", "宠物精灵图目录（默认 ~/.petdex/pets）")
	fs.DurationVar(&options.ShutdownTimeout, "shutdown-timeout", 0, "优雅停机超时（默认 10s）")

	// std flag 在第一个非选项参数处停止解析，因此允许 `loopra web --port 4567`
	// 与 `loopra --port 4567 web` 两种写法：先摘掉开头的子命令，再交给 flag 解析。
	command := ""
	if len(args) > 0 && (args[0] == commandWeb || args[0] == commandACP) {
		command = args[0]
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return invocation{}, err
	}
	positional := fs.Args()
	if len(positional) > 0 && (positional[0] == commandWeb || positional[0] == commandACP) {
		if command != "" && command != positional[0] {
			fs.Usage()
			return invocation{}, errUsage
		}
		command = positional[0]
		positional = positional[1:]
	}
	if command == "" {
		command = commandWeb
	}
	if command == commandACP {
		if len(positional) > 0 {
			fs.Usage()
			return invocation{}, errUsage
		}
		return invocation{Command: commandACP, Options: options}, nil
	}
	if len(positional) > 1 {
		fs.Usage()
		return invocation{}, errUsage
	}
	if len(positional) == 1 && options.Port == "" {
		options.Port = positional[0]
	}
	return invocation{Command: commandWeb, Options: options}, nil
}

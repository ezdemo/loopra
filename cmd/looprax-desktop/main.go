// Command looprax-desktop 在本机启动 Loopra API，并用 mygo 打开工作台。
//
// 页面与 API 同一源（http://127.0.0.1:<port>）。先在 web 目录执行 pnpm build，
// 或用 go build -tags webdist 把 web/dist 嵌进二进制。
//
//	go run ./cmd/looprax-desktop
//	go run ./cmd/looprax-desktop 4567   # 需要固定端口时再写
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/signal"
	"syscall"

	"github.com/egoist/mygo"

	"github.com/ezdemo/looprax/internal/appicon"
	"github.com/ezdemo/looprax/internal/bootstrap"
	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

func main() {
	// 桌面窗口就是界面。默认不占控制台；LOOPRA_DEBUG=1 时仍把日志打出来。
	if !logging.DebugEnabled() {
		logging.Silence()
		log.SetOutput(io.Discard)
	}
	var options config.Options
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: loopra-desktop [port] [flags]")
		fmt.Fprintln(os.Stderr, "starts the Loopra API and opens the workbench")
		flag.PrintDefaults()
	}
	flag.StringVar(&options.ConfigFile, "config", "", "配置文件路径（默认 manifest/config/config.yaml）")
	flag.StringVar(&options.Home, "home", "", "应用数据目录（默认 ~/.loopra）")
	flag.StringVar(&options.Port, "port", "", "HTTP 端口（未指定时由系统分配空闲端口）")
	flag.StringVar(&options.AccessKey, "access-key", "", "访问密钥（默认启动时生成）")
	flag.StringVar(&options.StaticDir, "static-dir", "", "前端目录（默认使用自行编译的 web/dist，或嵌进二进制的页面）")
	flag.StringVar(&options.PetsDir, "pets-dir", "", "宠物精灵图目录（默认 ~/.petdex/pets）")
	flag.DurationVar(&options.ShutdownTimeout, "shutdown-timeout", 0, "优雅停机超时（默认 10s）")
	if err := flag.CommandLine.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(2)
	}
	positional := flag.Args()
	if len(positional) > 1 {
		flag.Usage()
		os.Exit(2)
	}
	if len(positional) == 1 && options.Port == "" {
		options.Port = positional[0]
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	type listened struct{ base, key string }
	ready := make(chan listened, 1)
	options.OnListen = func(baseURL, accessKey string) {
		select {
		case ready <- listened{baseURL, accessKey}:
		default:
		}
	}
	errCh := make(chan error, 1)
	go func() { errCh <- bootstrap.Run(ctx, options) }()

	var info listened
	select {
	case err := <-errCh:
		if err != nil {
			logging.Errorf("desktop", "%v", err)
			os.Exit(1)
		}
		return
	case <-ctx.Done():
		return
	case info = <-ready:
	}

	target, err := url.Parse(info.base)
	if err != nil {
		logging.Errorf("desktop", "%v", err)
		stop()
		os.Exit(1)
	}
	origin := target.Scheme + "://" + target.Host
	query := target.Query()
	query.Set("rk", info.key)
	target.RawQuery = query.Encode()
	target.Path = "/"
	pageURL := target.String()

	go func() {
		<-ctx.Done()
		mygo.App.Quit()
	}()
	if err := appicon.Install(); err != nil {
		logging.Debugf("desktop", "launcher icon: %v", err)
	}
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "Loopra",
			URL:             pageURL,
			Width:           1280,
			Height:          840,
			MinWidth:        760,
			MinHeight:       520,
			Frameless:       true,
			BackgroundColor: "light-dark(#f8fafb, #191919)",
			StateKey:        "workspace",
			Page:            mygo.PageOptions{TrustedOrigins: []string{origin}},
		})
		if err := win.SetIcon(appicon.PNG); err != nil {
			logging.Debugf("desktop", "window icon: %v", err)
		}
		win.OnClosed(func() { stop() })
	})
	if err := mygo.App.Run(); err != nil {
		logging.Errorf("desktop", "%v", err)
		stop()
		os.Exit(1)
	}
	stop()
	if err := <-errCh; err != nil && !errors.Is(err, context.Canceled) {
		logging.Errorf("desktop", "%v", err)
		os.Exit(1)
	}
}

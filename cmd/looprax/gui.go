package main

import (
	"context"
	"errors"

	"github.com/egoist/mygo"

	"github.com/ezdemo/looprax/internal/bootstrap"
	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/petwin"
)

// runWeb serves the workbench and keeps a native pet window available.
// Closing the pet does not stop the server; Ctrl+C does.
func runWeb(ctx context.Context, stop func(), options config.Options) error {
	settings, err := config.Load(ctx, options)
	if err != nil {
		return err
	}
	host := petwin.New(settings.Home, settings.PetsDir)
	options.PetDesktop = host
	ready := make(chan struct{}, 1)
	previous := options.OnListen
	options.OnListen = func(baseURL, accessKey string) {
		if previous != nil {
			previous(baseURL, accessKey)
		}
		select {
		case ready <- struct{}{}:
		default:
		}
	}

	errCh := make(chan error, 1)
	go func() { errCh <- bootstrap.Run(ctx, options) }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		return nil
	case <-ready:
	}

	mygo.App.OnWindowAllClosed(func() {})
	go func() {
		<-ctx.Done()
		mygo.App.Quit()
	}()
	mygo.App.WhenReady(func() { host.Attach(nil) })
	if err := mygo.App.Run(); err != nil {
		logging.Errorf("server", "原生宠物窗口不可用：%v", err)
		<-ctx.Done()
	}
	stop()
	err = <-errCh
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

package bootstrap

import (
	"context"
	"os"
	"strings"

	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/almarelay"
)

func newRemoteRelay(settings *config.Server) (*almarelay.Manager, error) {
	return almarelay.NewManager(repository.NewAlmaRelayRepository(settings.Home), almarelay.Config{
		URL: strings.TrimSpace(os.Getenv("LOOPRA_ALMA_RELAY_URL")), Key: os.Getenv("LOOPRA_ALMA_RELAY_KEY"),
	})
}

// startRemoteRelay binds the transport to the finished API composition, before
// application startup, and shares backend's shutdown path.
func startRemoteRelay(remote *almarelay.Manager, backend *backend) {
	remote.Start(context.Background(), backend.controller.MobileRelayHost())
}

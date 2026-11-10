package bootstrap

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/config"
)

func TestAlmaRemoteOptInAndStableIdentity(t *testing.T) {
	home := t.TempDir()
	t.Setenv("LOOPRA_ALMA_RELAY_URL", "")
	t.Setenv("LOOPRA_ALMA_RELAY_KEY", "")
	settings := &config.Server{Home: home}
	disabled, err := newRemoteRelay(settings)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Status().Enabled {
		t.Fatal("remote enabled by default")
	}
	if _, err := os.Stat(filepath.Join(home, "alma-relay.json")); !os.IsNotExist(err) {
		t.Fatal("disabled remote wrote identity")
	}
	t.Setenv("LOOPRA_ALMA_RELAY_URL", "https://relay.example")
	first, err := newRemoteRelay(settings)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newRemoteRelay(settings)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status().PairingLink == "" || first.Status().PairingLink != second.Status().PairingLink {
		t.Fatal("pairing identity changed on restart")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

//go:build ignore

// Local interoperability fixture: the production desktop relay and HTTP router.
package main

import (
	"context"
	"encoding/base64"
	"io"
	"log"
	"os"

	"github.com/ezdemo/looprax/internal/controller"
	"github.com/ezdemo/looprax/internal/service/almarelay"
)

func main() {
	home, err := os.MkdirTemp("", "loopra-native-relay-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(home)
	desktop, _, err := controller.New(nil, controller.Options{Home: home, AccessKey: "fixture-only"})
	if err != nil {
		log.Fatal(err)
	}
	defer desktop.Close()
	controller.NewRouter(desktop)
	code := make([]byte, 32)
	for i := range code {
		code[i] = 7
	}
	relay, err := almarelay.New(almarelay.Config{URL: os.Args[1], Key: "fixture-only", ConnectCode: base64.RawURLEncoding.EncodeToString(code)})
	if err != nil {
		log.Fatal(err)
	}
	relay.Start(context.Background(), desktop.MobileRelayHost())
	defer relay.Close()
	// The Node fixture owns stdin; a killed test process also releases the desktop.
	_, _ = io.Copy(io.Discard, os.Stdin)
}

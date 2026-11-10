package controller

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/almarelay"
	"github.com/gogf/gf/v2/net/ghttp"
	"google.golang.org/genai"
)

// Opt-in only: normal Go tests do not require node_modules or an external
// checkout. All application data and model responses are local fixtures.
func TestLoopraMobileInteroperability(t *testing.T) {
	if os.Getenv("LOOPRA_MOBILE_INTEROP") != "1" {
		t.Skip("set LOOPRA_MOBILE_INTEROP=1 and LOOPRA_ALMA_RELAY_SOURCE to run the mobile client")
	}
	relaySource := os.Getenv("LOOPRA_ALMA_RELAY_SOURCE")
	if relaySource == "" {
		t.Fatal("LOOPRA_ALMA_RELAY_SOURCE is required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_, port, _ := net.SplitHostPort(address)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	process := exec.CommandContext(ctx, node, filepath.Join(relaySource, "index.mjs"))
	process.Dir = relaySource
	process.Env = append(os.Environ(), "HOST=127.0.0.1", "PORT="+port, "RELAY_REGISTRATION_KEY=mobile-fixture")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = process.Wait() }()
	relayURL := "http://" + address
	for {
		probe, err := (&http.Client{Timeout: time.Second}).Get(relayURL + "/healthz")
		if err == nil {
			_ = probe.Body.Close()
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("relay startup timed out")
		case <-time.After(20 * time.Millisecond):
		}
	}
	home := t.TempDir()
	cfg := config.Default()
	cfg.WorkspaceDir = t.TempDir()
	model := &abortStreamingModel{prior: echo.New("mobile-model", echo.Script{Thought: "mobile reasoning", Text: "你好 Loopra Mobile", Deltas: []string{"你好", " Loopra", " Mobile"}}), priorCalls: 1, parts: []*genai.Part{{Text: "任务继续运行"}}, ready: make(chan struct{})}
	a, err := agentpkg.New(home, "mobile-fixture", &cfg, agentpkg.Options{Model: model})
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := New(a, Options{Home: home, AccessKey: "desktop-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	router := NewRouter(s)
	router.BindHandler("GET:/api/fixture/binary", func(r *ghttp.Request) {
		r.Response.Header().Set("Content-Type", "application/octet-stream")
		_, _ = r.Response.RawWriter().Write([]byte{0, 1, 127, 128, 255})
	})
	canceled := make(chan struct{})
	router.BindHandler("GET:/api/fixture/wait", func(r *ghttp.Request) {
		r.Response.Header().Set("Content-Type", "text/event-stream")
		r.Response.RawWriter().(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	})
	code := make([]byte, 32)
	if _, err := rand.Read(code); err != nil {
		t.Fatal(err)
	}
	remote, err := almarelay.New(almarelay.Config{URL: relayURL, Key: "mobile-fixture", ConnectCode: base64.RawURLEncoding.EncodeToString(code)})
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	remote.Start(ctx, s.MobileRelayHost())
	for remote.Status().State != "connected" {
		select {
		case <-ctx.Done():
			t.Fatal("desktop relay registration timed out")
		case <-time.After(20 * time.Millisecond):
		}
	}
	probe := exec.CommandContext(ctx, node, filepath.Join("..", "..", "mobile", "tests", "interop-client.mjs"))
	probe.Env = append(os.Environ(), "LOOPRA_MOBILE_TEST_PAIRING="+remote.Status().PairingLink)
	output, err := probe.CombinedOutput()
	if err != nil {
		t.Fatalf("mobile interoperability: %v\n%s", err, output)
	}
	t.Log(string(output))
	select {
	case <-canceled:
	case <-ctx.Done():
		t.Fatal("request cancellation did not reach the native handler")
	}
	if !s.sessionPersisted("mobile-interop") {
		t.Fatal("mobile turn did not use normal session persistence")
	}
}

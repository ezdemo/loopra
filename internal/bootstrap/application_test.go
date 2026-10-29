package bootstrap

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/config"
)

func TestApplicationServesAndShutsDown(t *testing.T) {
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", "")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_, port, _ := net.SplitHostPort(address)
	listener.Close()

	home := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- Run(ctx, config.Options{
			Home: home, Port: port, AccessKey: "integration-key",
			PetsDir: filepath.Join(home, "pets"), ShutdownTimeout: 2 * time.Second,
		})
	}()
	waited := false
	t.Cleanup(func() {
		cancel()
		if !waited {
			select {
			case <-result:
			case <-time.After(5 * time.Second):
				t.Error("application did not stop")
			}
		}
	})

	client := &http.Client{Timeout: time.Second}
	url := "http://" + address + "/api/system/health"
	deadline := time.Now().Add(10 * time.Second)
	for {
		response, err := client.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("unauthenticated health = %d", response.StatusCode)
			}
			break
		}
		select {
		case err := <-result:
			waited = true
			t.Fatalf("startup failed: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("application did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("X-Loopra-Key", "integration-key")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Success bool `json:"success"`
	}
	err = json.NewDecoder(response.Body).Decode(&body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || !body.Success {
		t.Fatalf("authenticated health = %d, success=%v, err=%v", response.StatusCode, body.Success, err)
	}
	request, _ = http.NewRequest(http.MethodHead, url, nil)
	request.Header.Set("X-Loopra-Key", "integration-key")
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || len(data) != 0 {
		t.Fatalf("HEAD = %d, body=%q, err=%v", response.StatusCode, data, err)
	}
	client.CloseIdleConnections()
	cancel()
	select {
	case err := <-result:
		waited = true
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("application did not shut down")
	}
	client.CloseIdleConnections()
	if response, err := client.Get(url); err == nil {
		response.Body.Close()
		t.Fatal("application still accepts requests after shutdown")
	}
}

func TestApplicationReportsListenerFailure(t *testing.T) {
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", "")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	err = Run(context.Background(), config.Options{Home: t.TempDir(), Port: port, AccessKey: "test"})
	if err == nil {
		t.Fatal("occupied listener was accepted")
	}
}

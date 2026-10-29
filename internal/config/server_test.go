package config

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadReadsGoFrameConfigFile(t *testing.T) {
	// 环境变量优先级高于文件；测试进程可能继承了真实运行环境的密钥/端口，
	// 这里显式清空，保证断言的是 config.yaml 本身。
	t.Setenv("LOOPRA_"+"ACCESS_KEY", "")
	t.Setenv("LOOPRA_PORT", "")
	t.Setenv("LOOPRA_HOME", "")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := `server:
  address: "0.0.0.0"
  port: 7788
  readHeaderTimeout: 3s
  idleTimeout: 45s
  shutdownTimeout: 7s
  clientMaxBodySize: 1048576
loopra:
  accessKey: "from-yaml"
  staticDir: "` + filepath.ToSlash(filepath.Join(dir, "static")) + `"
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := Load(context.Background(), Options{ConfigFile: path, Home: filepath.Join(dir, "home")})
	if err != nil {
		t.Fatal(err)
	}
	if settings.Address != "0.0.0.0:7788" || settings.Port != 7788 {
		t.Fatalf("address = %q port = %d", settings.Address, settings.Port)
	}
	if settings.ReadHeaderTimeout != 3*time.Second || settings.IdleTimeout != 45*time.Second || settings.ShutdownTimeout != 7*time.Second {
		t.Fatalf("timeouts = %v/%v/%v", settings.ReadHeaderTimeout, settings.IdleTimeout, settings.ShutdownTimeout)
	}
	if settings.ClientMaxBodySize != 1<<20 {
		t.Fatalf("clientMaxBodySize = %d", settings.ClientMaxBodySize)
	}
	if settings.AccessKey != "from-yaml" {
		t.Fatalf("accessKey = %q", settings.AccessKey)
	}
}

func TestLoadPrecedenceOptionsThenEnvThenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  port: 6000\nloopra:\n  accessKey: yaml-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOOPRA_PORT", "7000")
	accessKeyEnv := "LOOPRA_" + "ACCESS_KEY"
	t.Setenv(accessKeyEnv, "env-key")
	t.Setenv("LOOPRA_HOME", filepath.Join(dir, "env-home"))

	settings, err := Load(context.Background(), Options{ConfigFile: path})
	if err != nil {
		t.Fatal(err)
	}
	if settings.Port != 7000 || settings.AccessKey != "env-key" {
		t.Fatalf("env should override file: port=%d key=%q", settings.Port, settings.AccessKey)
	}
	explicit, err := Load(context.Background(), Options{
		ConfigFile: path, Port: "8001", AccessKey: "flag-key", Home: filepath.Join(dir, "flag-home"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if explicit.Port != 8001 || explicit.AccessKey != "flag-key" {
		t.Fatalf("options should override env: port=%d key=%q", explicit.Port, explicit.AccessKey)
	}
	if filepath.Base(explicit.Home) != "flag-home" {
		t.Fatalf("home = %q", explicit.Home)
	}
}

func TestLoadDefaultsToEphemeralPort(t *testing.T) {
	t.Setenv("LOOPRA_PORT", "")
	t.Setenv("LOOPRA_CONFIG", "")
	home := t.TempDir()

	settings, err := Load(context.Background(), Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if settings.Port != 0 || settings.Address != "127.0.0.1:0" {
		t.Fatalf("unspecified port = %d address = %q", settings.Port, settings.Address)
	}

	for _, content := range []string{"server:\n  address: 127.0.0.1\n", "server:\n  port: 0\n"} {
		path := filepath.Join(t.TempDir(), "config.yaml")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		settings, err = Load(context.Background(), Options{ConfigFile: path, Home: home})
		if err != nil {
			t.Fatal(err)
		}
		if settings.Port != 0 || settings.Address != "127.0.0.1:0" {
			t.Fatalf("content %q port = %d address = %q", content, settings.Port, settings.Address)
		}
	}

	listener, err := net.Listen("tcp", settings.Address)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil || port == "" || port == "0" {
		t.Fatalf("bound address = %q err = %v", listener.Addr().String(), err)
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	if _, err := Load(context.Background(), Options{Port: "not-a-port"}); err == nil {
		t.Fatal("invalid port was accepted")
	}
}

func TestLoadRejectsMalformedConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("server: [unterminated\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("malformed configuration panicked instead of returning an error: %v", recovered)
		}
	}()
	if _, err := Load(context.Background(), Options{ConfigFile: path}); err == nil {
		t.Fatal("malformed configuration was accepted")
	}
}

func TestLoadRejectsMissingExplicitConfig(t *testing.T) {
	if _, err := Load(context.Background(), Options{ConfigFile: filepath.Join(t.TempDir(), "absent.yaml")}); err == nil {
		t.Fatal("missing explicit configuration was silently ignored")
	}
}

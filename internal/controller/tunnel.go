package controller

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/ezdemo/looprax/internal/repository"
)

type tunnelState struct {
	mu                             sync.Mutex
	cmd                            *exec.Cmd
	running                        bool
	publicURL, localURL, errorText string
	pid                            int
	proxy                          *http.Server
}

var tunnelURL = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)

func (s *Controller) tunnelController(w http.ResponseWriter, r *http.Request, action string) {
	t := s.state.tunnel
	if action == "tunnel/config" || action == "tunnel/start" {
		var body struct {
			ExecutablePath string `json:"executablePath"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		if action == "tunnel/config" || body.ExecutablePath != "" {
			if err := repository.WriteJSON(s.tunnelConfigPath(), body); err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	}
	t.mu.Lock()
	switch action {
	case "tunnel/stop":
		if t.cmd != nil && t.running {
			_ = t.cmd.Process.Kill()
		}
		t.running = false
		t.errorText = ""
		if t.proxy != nil {
			_ = t.proxy.Close()
			t.proxy = nil
		}
	case "tunnel/start":
		if !t.running {
			cfg := s.mcpExportLoad()
			if cfg.Enabled == nil || !*cfg.Enabled {
				t.mu.Unlock()
				writeFail(w, http.StatusBadRequest, "请先启用 MCP 服务")
				return
			}
			executable := detectCloudflared(s)
			if executable == "" {
				t.mu.Unlock()
				writeFail(w, http.StatusBadRequest, "未找到 cloudflared，请先安装或配置可执行文件路径")
				return
			}
			proxy, origin, err := startTunnelProxy(r.Host, cfg.Endpoint)
			if err != nil {
				t.mu.Unlock()
				writeFail(w, http.StatusBadRequest, err.Error())
				return
			}
			cmd := exec.Command(executable, "tunnel", "--url", origin, "--no-autoupdate")
			hideProcess(cmd)
			reader, writer := io.Pipe()
			cmd.Stdout = writer
			cmd.Stderr = writer
			if err := cmd.Start(); err != nil {
				_ = proxy.Close()
				reader.Close()
				writer.Close()
				t.errorText = err.Error()
				t.mu.Unlock()
				writeFail(w, http.StatusBadRequest, err.Error())
				return
			}
			t.cmd, t.running, t.publicURL, t.localURL, t.errorText, t.pid = cmd, true, "", origin+cfg.Endpoint, "", cmd.Process.Pid
			t.proxy = proxy
			go func() {
				scanner := bufio.NewScanner(reader)
				scanner.Buffer(make([]byte, 4096), 1<<20)
				for scanner.Scan() {
					if url := tunnelURL.FindString(scanner.Text()); url != "" {
						t.mu.Lock()
						if t.cmd == cmd {
							t.publicURL = url
						}
						t.mu.Unlock()
					}
				}
				reader.Close()
			}()
			go func() {
				err := cmd.Wait()
				writer.Close()
				_ = proxy.Close()
				t.mu.Lock()
				if t.cmd == cmd {
					if err != nil && t.running {
						t.errorText = err.Error()
					}
					t.running = false
				}
				t.mu.Unlock()
			}()
		}
	}
	cfg := s.mcpExportLoad()
	ready := cfg.Enabled != nil && *cfg.Enabled
	state := "stopped"
	if detectCloudflared(s) != "" {
		state = "stopped"
	}
	if t.running {
		state = "starting"
		if t.publicURL != "" {
			state = "running"
		}
	}
	if t.errorText != "" && !t.running {
		state = "error"
	}
	configured, _ := repository.ReadObject(s.tunnelConfigPath())["executablePath"].(string)
	status := map[string]any{"state": state, "running": t.running, "installed": detectCloudflared(s) != "", "quickTunnel": true, "mcpReady": ready, "platform": runtime.GOOS, "configuredExecutablePath": configured, "executablePath": detectCloudflared(s), "localUrl": t.localURL, "publicUrl": t.publicURL, "mcpEndpoint": cfg.Endpoint, "error": t.errorText, "pid": t.pid}
	if t.publicURL == "" {
		delete(status, "publicUrl")
	}
	if t.errorText == "" {
		delete(status, "error")
	}
	if t.localURL == "" {
		status["localUrl"] = "http://" + r.Host + cfg.Endpoint
	}
	if detectCloudflared(s) == "" {
		name := "cloudflared"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		status["executablePath"] = name
	}
	t.mu.Unlock()
	writeOK(w, http.StatusOK, status)
}

func (s *Controller) Close() error {
	s.tasks.Stop()
	s.abortAll()
	s.acp.CloseAll()
	t := s.state.tunnel
	t.mu.Lock()
	defer t.mu.Unlock()
	var errs []error
	if t.cmd != nil {
		// 进程可能已自行退出；os.ErrProcessDone 不是停机失败。
		if err := t.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			errs = append(errs, fmt.Errorf("stop tunnel: %w", err))
		}
	}
	t.running = false
	if t.proxy != nil {
		if err := t.proxy.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs = append(errs, err)
		}
		t.proxy = nil
	}
	return errors.Join(errs...)
}

func startTunnelProxy(host, endpoint string) (*http.Server, string, error) {
	_, port, err := net.SplitHostPort(host)
	if err != nil {
		return nil, "", fmt.Errorf("无法确定 Web 服务端口")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return nil, "", fmt.Errorf("无效的 Web 服务端口")
	}
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", port)}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) { director(r); r.Host = target.Host }
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, "", err
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != endpoint && !strings.HasPrefix(r.URL.Path, endpoint+"/") {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})}
	go server.Serve(listener)
	return server, "http://" + listener.Addr().String(), nil
}

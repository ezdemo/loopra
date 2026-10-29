package bootstrap

import (
	"context"
	"errors"
	"math"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"

	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/acp"
)

// httpServer 同时是 Spring 的 ApplicationRunner（Run）与 DisposableBean（Destroy）：
// 容器刷新完成后开始监听，进程退出时优雅停机。
type httpServer struct {
	server   *ghttp.Server
	listener net.Listener
	backend  *backend
	settings *config.Server

	closeOnce sync.Once
	closeErr  error
}

func newHTTPServer(settings *config.Server, backend *backend, router *ghttp.Server) (*httpServer, error) {
	listener, err := net.Listen("tcp", settings.Address)
	if err != nil {
		return nil, err
	}
	if err := router.SetListener(listener); err != nil {
		return nil, errors.Join(err, listener.Close())
	}
	// 端口为 0 时，这里换成系统实际分配的地址，后续日志和桌面窗口都用这个端口。
	if tcp, ok := listener.Addr().(*net.TCPAddr); ok {
		settings.Port = tcp.Port
		settings.Address = tcp.String()
	}
	router.SetAddr(listener.Addr().String())
	// GoFrame v2.10 只暴露 SetReadTimeout（覆盖整个请求体），没有
	// ReadHeaderTimeout。若把 10s 的头部超时映射过去，会误伤大文件上传，
	// 因此这里保持不限读超时（与迁移前“只限制头部、不限请求体”的观感一致），
	// 仅保留空闲连接回收。服务默认只监听 127.0.0.1，暴露面有限。
	router.SetReadTimeout(0)
	router.SetIdleTimeout(settings.IdleTimeout)
	router.SetClientMaxBodySize(int64(settings.ClientMaxBodySize))
	shutdownSeconds := int(math.Ceil(settings.ShutdownTimeout.Seconds()))
	if shutdownSeconds < 1 {
		shutdownSeconds = 1
	}
	// GoFrame 内部真正生效的是 GracefulTimeout（ghttp_server_graceful.go 用它
	// 构造 graceful.Server）；SetGracefulShutdownTimeout 只影响查询用的字段，
	// 两个都设置，避免停机时仍按默认 2s 截断在途请求。
	router.SetGracefulTimeout(shutdownSeconds)
	router.SetGracefulShutdownTimeout(shutdownSeconds)
	return &httpServer{
		server: router, listener: listener, backend: backend, settings: settings,
	}, nil
}

// Run 实现 spring.ApplicationRunner：启动 GoFrame 服务器并阻塞到上下文取消。
func (s *httpServer) Run(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return nil
	}
	if err := s.server.Start(); err != nil {
		return err
	}
	address := s.listener.Addr().String()
	host, port, splitErr := net.SplitHostPort(address)
	baseURL := "http://" + address
	if splitErr == nil {
		baseURL = "http://" + net.JoinHostPort(host, port)
	}
	logging.PrintLine("[Web Interface]:  " + baseURL + "/index.html?rk=" + s.backend.accessKey)
	static := s.settings.StaticLabel
	if static == "" {
		static = s.settings.StaticDir
	}
	logging.Debugf("server", "home=%s static=%s", s.settings.Home, static)
	var ready []string
	for _, provider := range acp.Providers {
		availability := provider.Detect()
		if availability.Available {
			ready = append(ready, provider.Name)
			continue
		}
		logging.Debugf("acp", "%s unavailable: %s", provider.Name, availability.Detail)
	}
	if len(ready) > 0 {
		logging.Debugf("acp", "engines %s", strings.Join(ready, ", "))
	}

	deadline := time.Now().Add(5 * time.Second)
	for s.server.Status() != ghttp.ServerStatusRunning {
		if time.Now().After(deadline) {
			return errors.New("GoFrame server did not reach the running state")
		}
		time.Sleep(time.Millisecond)
	}
	if s.settings.OnListen != nil {
		s.settings.OnListen(baseURL, s.backend.accessKey)
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if s.server.Status() == ghttp.ServerStatusStopped {
				return errors.New("GoFrame server stopped unexpectedly")
			}
		}
	}
}

// Destroy 实现 spring.DisposableBean：先取消智能体流，再优雅停机。
func (s *httpServer) Destroy(context.Context) error { return s.close() }

func (s *httpServer) close() error {
	s.closeOnce.Do(func() {
		logging.Infof("server", "shutting down")
		// Cancel active agent streams before waiting for HTTP handlers to drain.
		backendErr := s.backend.Close()
		shutdownErr := s.server.Shutdown()
		listenerErr := s.listener.Close()
		if errors.Is(listenerErr, net.ErrClosed) {
			listenerErr = nil
		}
		s.closeErr = errors.Join(backendErr, shutdownErr, listenerErr)
	})
	return s.closeErr
}

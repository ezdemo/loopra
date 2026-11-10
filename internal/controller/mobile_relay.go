package controller

import (
	"net/http"
	"strings"
	"sync"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/almarelay"
)

func (s *Controller) MobileRelayHost() almarelay.Host { return s.mobileRelay }

// A paired Loopra device has the same API access as the workbench. The local
// access key stays on the desktop; requests still pass through the actual
// router, access-key middleware and workspace/approval policies.
type mobileRelayHost struct {
	mu      sync.RWMutex
	handler http.Handler
	key     string
	closed  bool
	workers sync.WaitGroup
}

// BindMobileHTTP is called only after the application's router is initialized.
func (s *Controller) BindMobileHTTP(handler http.Handler) {
	s.mobileRelay.mu.Lock()
	s.mobileRelay.handler = handler
	s.mobileRelay.mu.Unlock()
}

func (h *mobileRelayHost) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.URL.IsAbs() || request.URL.Host != "" || !strings.HasPrefix(request.URL.Path, "/api/") || strings.ContainsAny(request.URL.Path, "\\\x00") {
		writeFailReason(w, http.StatusBadRequest, "无效的移动端请求路径", "invalid_mobile_path")
		return
	}
	h.mu.Lock()
	handler := h.handler
	if handler == nil || h.closed {
		h.mu.Unlock()
		writeFailReason(w, http.StatusServiceUnavailable, "桌面服务尚未就绪", "mobile_not_ready")
		return
	}
	h.workers.Add(1)
	h.mu.Unlock()
	ctx := request.Context()
	request = request.Clone(ctx)
	request.Header.Set("X-Loopra-Key", h.key)
	request.Host = "loopra.mobile"
	request.RemoteAddr = "127.0.0.1:0"
	request.RequestURI = request.URL.RequestURI()
	// Chat handlers deliberately outlive an HTTP disconnect. They belong to
	// the application, while the phone's request worker must be free to exit.
	done := make(chan struct{})
	go func() {
		defer h.workers.Done()
		defer close(done)
		defer func() {
			if failure := recover(); failure != nil && failure != http.ErrAbortHandler {
				logging.Errorf("relay", "mobile handler panic: %v", failure)
				if request.Context().Err() == nil {
					writeFail(w, http.StatusInternalServerError, "移动端请求失败")
				}
			}
		}()
		handler.ServeHTTP(w, request)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (h *mobileRelayHost) stopAccepting() { h.mu.Lock(); h.closed = true; h.mu.Unlock() }
func (h *mobileRelayHost) wait()          { h.workers.Wait() }

func (s *Controller) mobileHandshake(w http.ResponseWriter, _ *http.Request) {
	writeOK(w, http.StatusOK, map[string]any{
		"protocol": "loopra-relay", "version": 1, "serverVersion": Version,
		"capabilities": []string{"http", "sse", "binary"},
	})
}

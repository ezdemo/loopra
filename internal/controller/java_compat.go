package controller

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

// LOOPRA_JAVA_BACKEND_URL 非空时，把当前请求转发给可选的 Java 后端。
// 该地址会接管整条 /api 与 /mcp。原生插件由 moejs 执行，配置了这个地址后本进程不加载它们。
func (s *Controller) javaCompatibilityProxy(w http.ResponseWriter, r *http.Request) bool {
	address := os.Getenv("LOOPRA_JAVA_BACKEND_URL")
	if address == "" {
		return false
	}
	target, err := url.Parse(address)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		writeFail(w, http.StatusBadGateway, "Java 兼容服务地址无效")
		return true
	}
	if target.Host == r.Host {
		writeFail(w, http.StatusBadGateway, "Java 兼容服务不能指向自身")
		return true
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	director := proxy.Director
	proxy.Director = func(request *http.Request) {
		director(request)
		if key := os.Getenv("LOOPRA_JAVA_BACKEND_KEY"); key != "" {
			request.Header.Set("X-Loopra-Key", key)
		}
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		writeFail(w, http.StatusBadGateway, "Java 兼容服务不可用")
	}
	proxy.ServeHTTP(w, r)
	return true
}

// 选择 JVM 兼容时委派完整 API，使插件钩子、
// 引擎执行、审批和会话历史共享同一运行时。
func (s *Controller) compatibilityHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("LOOPRA_JAVA_BACKEND_URL") != "" && (r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/")) && !s.key.Match(r.Header.Get("X-Loopra-Key")) {
			writeFailReason(w, http.StatusUnauthorized, "访问密钥缺失或错误，请输入启动日志中的 rk 密钥", "access_key_required")
			return
		}
		if (r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/")) && s.javaCompatibilityProxy(w, r) {
			return
		}
		next.ServeHTTP(w, r)
	})
}

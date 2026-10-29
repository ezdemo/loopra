package controller

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

var routerSequence atomic.Uint64

// NewServer 在启动时装配一次 GoFrame 服务器。
//
// 中间件顺序保持与旧链路一致：访问日志 → CORS → 访问密钥 →
// Java 兼容代理 → MCP 导出 → 工作区运行时 → 尾斜杠重定向。
// 业务处理器仍然只依赖 net/http，GoFrame 负责监听、路由与生命周期。
func NewServer(controller *Controller, name string) *ghttp.Server {
	server := ghttp.GetServer(name)
	server.SetName(name)
	server.SetDumpRouterMap(false)
	server.SetAccessLogEnabled(false)
	server.SetErrorLogEnabled(false)
	server.SetLogStdout(false)
	// GoFrame 每次 Start 都会打「openapi specification is disabled」。
	// SetLogStdout 管不到这条，只能把服务器自己的 logger 收到错误级别。
	logging.QuietLogger(server.Logger())
	server.SetClientMaxBodySize(0)
	server.Use(
		requestLog,
		controller.httpChain,
		controller.canonicalSlashRedirect,
	)
	server.BindStatusHandlerByMap(map[int]ghttp.HandlerFunc{
		http.StatusNotFound: handleNotFound,
		http.StatusInternalServerError: func(r *ghttp.Request) {
			// 业务处理器可能已经写了自己的 500 envelope；RawWriter 的
			// 字节无法通过 ClearBuffer 撤回，再写会追加第二份 JSON。
			if r.Response.IsHeaderWrote() || r.Response.BytesWritten() > 0 {
				return
			}
			r.Response.ClearBuffer()
			writeFail(r.Response.RawWriter(), http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError))
		},
	})
	controller.RegisterRoutes(server)
	return server
}

// NewRouter 返回可直接作为 http.Handler 使用的 GoFrame 服务器，
// 供 httptest 与嵌入式场景复用生产路由。
//
// ghttp.Server.ServeHTTP 依赖 Start 初始化会话管理器与运行时配置，
// 因此这里先在临时端口启动一次再关闭监听；路由表与会话管理器会保留，
// 后续 httptest 调用 ServeHTTP 不受影响。
func NewRouter(controller *Controller) *ghttp.Server {
	server := NewServer(controller, newServerName())
	server.SetAddr("127.0.0.1:0")
	if err := server.Start(); err != nil {
		panic(fmt.Errorf("prepare GoFrame router: %w", err))
	}
	deadline := time.Now().Add(2 * time.Second)
	for server.Status() != ghttp.ServerStatusRunning {
		if time.Now().After(deadline) {
			_ = server.Shutdown()
			panic(fmt.Errorf("timed out starting GoFrame router %s", server.GetName()))
		}
		time.Sleep(time.Millisecond)
	}
	if err := server.Shutdown(); err != nil {
		panic(fmt.Errorf("release GoFrame router listener: %w", err))
	}
	return server
}

func newServerName() string {
	return fmt.Sprintf("looprax-%d-%d", os.Getpid(), routerSequence.Add(1))
}

// Handler 返回可直接用于 httptest 与嵌入式场景的 http.Handler。
func (s *Controller) Handler() http.Handler { return NewRouter(s) }

// RegisterRoutes 是 HTTP 模块边界；路由只在启动时装配一次。
func (s *Controller) RegisterRoutes(server *ghttp.Server) {
	api := newAPIRouter(s, server, "/api")
	s.registerChatRoutes(api)
	s.registerToolsRoutes(api)
	s.registerConfigRoutes(api)
	s.registerSessionsRoutes(api)
	s.registerAgentRoutes(api)
	s.registerSystemRoutes(api)
	s.registerFilesRoutes(api)
	s.registerExtensionsRoutes(api)
	s.registerTasksRoutes(api)

	health := func(r *ghttp.Request) {
		withResponseWriter(r, func(w http.ResponseWriter) {
			writeOK(w, http.StatusOK, map[string]any{
				"status": "ok", "version": "0.1.0-go", "buildTime": "",
			})
		})
	}
	api.GET("/system/health", health)
	api.HEAD("/system/health", health)
	api.flush()

	settings := func(r *ghttp.Request) {
		r.Response.Header().Set("Content-Type", "application/json")
		_, _ = r.Response.WriteString("{\n  \"apiBase\": \"/\"\n}")
	}
	server.BindHandler("GET:/config.json", settings)
	server.BindHandler("HEAD:/config.json", settings)

	static := s.staticRoute()
	server.BindHandler("GET:/", static)
	server.BindHandler("HEAD:/", static)
	server.BindHandler("GET:/*", static)
	server.BindHandler("HEAD:/*", static)
}

func (s *Controller) staticRoute() ghttp.HandlerFunc {
	handler := s.staticHandler()
	return func(r *ghttp.Request) {
		withResponseWriter(r, func(w http.ResponseWriter) {
			handler.ServeHTTP(w, r.Request)
		})
	}
}

// withResponseWriter 把 GoFrame 的原始写入器交给 net/http 处理器，
// 并在返回后把状态码同步给 GoFrame，避免未匹配状态被改写为 200。
func withResponseWriter(r *ghttp.Request, handle func(http.ResponseWriter)) {
	recorder := &responseRecorder{ResponseWriter: r.Response.RawWriter()}
	handle(recorder)
	if recorder.status != 0 {
		r.Response.Status = recorder.status
	}
}

// responseRecorder 记录状态码与字节数，并保留 Flush 能力供 SSE 使用。
type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *responseRecorder) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *responseRecorder) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytes += int64(n)
	return n, err
}

func (w *responseRecorder) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *responseRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// httpChain 把既有的 net/http 过滤器适配到 GoFrame 中间件链。
// 一次请求只创建一个记录型写入器，状态码在链尾统一回写。
func (s *Controller) httpChain(r *ghttp.Request) {
	recorder := &responseRecorder{ResponseWriter: r.Response.RawWriter()}
	terminal := http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		r.Request = request
		r.Middleware.Next()
	})
	chain := http.Handler(terminal)
	chain = s.scopeHTTP(chain)
	// 方法不匹配必须在静态兜底与业务处理器之前判定：一旦响应写到了
	// RawWriter，再改 405 只能追加 body，状态码也回不去。
	chain = s.routeGuard(chain)
	chain = s.exportHTTP(chain)
	chain = s.compatibilityHTTP(chain)
	chain = s.key.auth(chain)
	chain = cors(chain)
	chain = recoverHTTP(chain)
	chain.ServeHTTP(recorder, r.Request)
	if recorder.status != 0 {
		r.Response.Status = recorder.status
	}
}

// routeGuard 在路由分发前返回 405，避免静态兜底把“方法不允许”
// 误报成 404，或已提交响应后再追加 body。
//
// 判定使用 apiRouter 自己在注册时收集的 routeTable，因此精确路由、
// 尾斜杠处理器与 /* 通配的语义与 dispatch 完全一致，不依赖
// GoFrame 的 RegRule 或路由优先级。
func (s *Controller) routeGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions ||
			!(r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/")) {
			next.ServeHTTP(w, r)
			return
		}
		if s.routes == nil || s.routes.matches(r.Method, r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		methods := s.routes.allowed(r.URL.Path)
		if len(methods) == 0 {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Allow", strings.Join(methods, ", "))
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
	})
}

func recoverHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if exception := recover(); exception != nil {
				// http.ErrAbortHandler 表示连接已被调用方中止，交给
				// net/http 静默处理，不要再写一份 500。
				if exception == http.ErrAbortHandler {
					panic(exception)
				}
				logging.Errorf("http", "panic: %v", exception)
				writeFail(w, http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLog 默认只记录 API 的 5xx，以及除 401 以外的 4xx。
// 401 是前端在填入访问密钥之前对 session-status 之类接口的轮询，每隔几秒一次，留在调试日志里。
// 成功请求和静态资源（含浏览器的 favicon 404）同样只在调试模式输出。
func requestLog(r *ghttp.Request) {
	start := time.Now()
	r.Middleware.Next()
	status := r.Response.Status
	if status == 0 {
		status = http.StatusOK
	}
	path := r.URL.Path
	api := path == "/api" || strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/mcp")
	line := fmt.Sprintf("%s %s %d %s %dB", r.Method, path, status, time.Since(start).Round(time.Millisecond), int64(r.Response.BufferLength())+r.Response.BytesWritten())
	switch {
	case status >= 500:
		logging.Errorf("http", "%s", line)
	case status >= 400 && status != http.StatusUnauthorized && api:
		logging.Warnf("http", "%s", line)
	default:
		logging.Debugf("http", "%s", line)
	}
}

// action 把应用层基于 net/http 的控制器适配为 GoFrame 处理器。
func (s *Controller) action(handler func(*Controller, http.ResponseWriter, *http.Request)) ghttp.HandlerFunc {
	bound := s.bind(handler)
	return func(r *ghttp.Request) {
		setRouterPathValues(r)
		withResponseWriter(r, func(w http.ResponseWriter) {
			bound.ServeHTTP(w, r.Request)
		})
	}
}

// setRouterPathValues 用转义后的原始路径重新提取路由参数，避免
// GoFrame 对已解码的 URL.Path 再解码一次（a%252Fb 会被解成 a/b）。
func setRouterPathValues(r *ghttp.Request) {
	if r.Router == nil || len(r.Router.RegNames) == 0 {
		return
	}
	pattern, err := regexp.Compile(r.Router.RegRule)
	if err != nil {
		return
	}
	matches := pattern.FindStringSubmatch(r.URL.EscapedPath())
	if len(matches) == 0 {
		return
	}
	for index, name := range r.Router.RegNames {
		if index+1 >= len(matches) {
			break
		}
		value, err := url.PathUnescape(matches[index+1])
		if err != nil {
			value = matches[index+1]
		}
		r.Request.SetPathValue(name, value)
	}
}

func (s *Controller) canonicalRedirect(method, path string) {
	if s.redirects == nil {
		s.redirects = make(map[string]struct{})
	}
	s.redirects[method+":"+path] = struct{}{}
}

// canonicalSlashRedirect 保留 Java API 显式的尾斜杠 301 契约。
func (s *Controller) canonicalSlashRedirect(r *ghttp.Request) {
	rawPath := r.RequestURI
	if query := strings.IndexByte(rawPath, '?'); query >= 0 {
		rawPath = rawPath[:query]
	}
	if strings.HasSuffix(rawPath, "/") {
		r.Middleware.Next()
		return
	}
	if !s.matchesCanonicalRedirect(r.Method, strings.TrimRight(r.URL.Path, "/")) {
		r.Middleware.Next()
		return
	}
	target := *r.URL
	target.Path += "/"
	if target.RawPath != "" {
		target.RawPath += "/"
	}
	r.Response.RedirectTo(target.RequestURI(), http.StatusMovedPermanently)
}

func (s *Controller) matchesCanonicalRedirect(method, path string) bool {
	prefix := method + ":"
	for key := range s.redirects {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if matchPathPattern(strings.TrimPrefix(key, prefix), path) {
			return true
		}
	}
	return false
}

// matchPathPattern 支持精确段、:param/{param} 与末尾 * 通配。
func matchPathPattern(pattern, path string) bool {
	patternParts := splitPath(pattern)
	pathParts := splitPath(path)
	for i, part := range patternParts {
		if strings.HasPrefix(part, "*") {
			return len(pathParts) >= i
		}
		if i >= len(pathParts) || !matchPathSegment(part, pathParts[i]) {
			return false
		}
	}
	return len(patternParts) == len(pathParts)
}

// matchPathSegment 匹配单个路径段：字面量、:param 或 {param}。
func matchPathSegment(pattern, value string) bool {
	switch {
	case strings.HasPrefix(pattern, "*"):
		return true
	case strings.HasPrefix(pattern, ":"):
		return value != ""
	case strings.HasPrefix(pattern, "{") && strings.HasSuffix(pattern, "}"):
		return value != ""
	default:
		return pattern == value
	}
}

func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func handleNotFound(r *ghttp.Request) {
	// 静态回退或业务处理器可能已经写出了自己的 404；保留它们的状态码。
	// 方法不匹配已由 methodNotAllowed 在分发前处理，这里只负责纯 404。
	if r.Response.IsHeaderWrote() || r.Response.BytesWritten() > 0 {
		return
	}
	r.Response.ClearBuffer()
	http.NotFound(r.Response.RawWriter(), r.Request)
}

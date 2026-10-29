package controller

import (
	"net/http"
)

// 跨域策略与 Java 链路完全一致：
// CrossFilter(-100, allowedOrigins "*", allowCredentials false) 在
// WebAccessFilter(-90) 之前响应预检请求，因此 401 响应仍会携带
// CORS 头；GlobalExceptionFilter 会为每个带有 Origin 的响应回写这些头。
// 始终不发送 Allow-Credentials。
const (
	// 来自 WebAccessFilter.java L39 的显式列表。
	corsAllowHeaders = "Content-Type,X-Loopra-Key,X-Request-ID,X-Timestamp," +
		"Authorization,Mcp-Session-Id,Mcp-Protocol-Version,Last-Event-ID"
	// GlobalExceptionFilter.applyCorsHeaders 中固定的方法列表。
	corsAllowMethods  = "GET, POST, PUT, DELETE, PATCH, OPTIONS"
	corsExposeHeaders = "Mcp-Session-Id"
	corsMaxAge        = "3600"
)

// cors 在访问过滤器之外包裹处理器链。
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if r.Method == http.MethodOptions {
			// 预检请求在认证之前完成，无论密钥如何
			// 都返回空的 200。
			if origin != "" {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Methods",
					r.Header.Get("Access-Control-Request-Method"))
				h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
				h.Set("Access-Control-Expose-Headers", corsExposeHeaders)
				h.Set("Access-Control-Max-Age", corsMaxAge)
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		if origin != "" {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", corsAllowMethods)
			h.Set("Access-Control-Allow-Headers", "*")
			h.Set("Access-Control-Expose-Headers", corsExposeHeaders)
			h.Set("Access-Control-Max-Age", corsMaxAge)
		}
		next.ServeHTTP(w, r)
	})
}

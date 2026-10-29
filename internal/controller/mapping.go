package controller

import (
	"net/http"
	"strings"

	"github.com/gogf/gf/v2/net/ghttp"
)

// apiRouter 是 Spring MVC 风格的路由注册器。
//
// 注册先收集到 routeEntry，最后由 flush 为每个「方法 + 基路径」只绑定
// 一条 GoFrame 路由。这样做有两个原因：
//
//  1. GoFrame 会把 /pets 与 /pets/ 归一为同一模式；
//  2. GoFrame 认为 /x/* 比 /x 更深、优先级更高，若两条都注册，
//     精确请求会错误命中通配处理器。
//
// 分发器根据原始 RequestURI 是否带尾斜杠，在精确处理器、斜杠处理器
// 与通配处理器之间选择，从而保留旧 API 的契约。
type apiRouter struct {
	server *ghttp.Server
	prefix string
	routes map[string]*routeEntry
	owner  *Controller
}

type routeEntry struct {
	method string
	base   string
	exact  ghttp.HandlerFunc
	slash  ghttp.HandlerFunc
	fuzzy  ghttp.HandlerFunc
}

func newAPIRouter(controller *Controller, server *ghttp.Server, prefix string) *apiRouter {
	return &apiRouter{
		server: server,
		prefix: strings.TrimRight(prefix, "/"),
		routes: make(map[string]*routeEntry),
		owner:  controller,
	}
}

// Group 创建带前缀的子路由，等价于 Spring 的 @RequestMapping 分组。
func (r *apiRouter) Group(prefix string) *apiRouter {
	return &apiRouter{
		server: r.server,
		prefix: r.prefix + normalizeAPIPath(prefix),
		routes: r.routes,
		owner:  r.owner,
	}
}

func (r *apiRouter) GET(path string, handler ghttp.HandlerFunc) {
	r.bind(http.MethodGet, path, handler)
}
func (r *apiRouter) HEAD(path string, handler ghttp.HandlerFunc) {
	r.bind(http.MethodHead, path, handler)
}
func (r *apiRouter) POST(path string, handler ghttp.HandlerFunc) {
	r.bind(http.MethodPost, path, handler)
}
func (r *apiRouter) PUT(path string, handler ghttp.HandlerFunc) {
	r.bind(http.MethodPut, path, handler)
}
func (r *apiRouter) PATCH(path string, handler ghttp.HandlerFunc) {
	r.bind(http.MethodPatch, path, handler)
}
func (r *apiRouter) DELETE(path string, handler ghttp.HandlerFunc) {
	r.bind(http.MethodDelete, path, handler)
}

func (r *apiRouter) bind(method, path string, handler ghttp.HandlerFunc) {
	full := normalizeAPIPath(r.prefix + path)
	base := strings.TrimSuffix(full, "/*")
	key := method + " " + base
	entry := r.routes[key]
	if entry == nil {
		entry = &routeEntry{method: method, base: base}
		r.routes[key] = entry
	}
	switch {
	case strings.HasSuffix(full, "/*"):
		entry.fuzzy = handler
	case strings.HasSuffix(path, "/") && path != "/":
		entry.slash = handler
	default:
		entry.exact = handler
	}
}

// Redirect 注册尾斜杠重定向契约，不绑定业务处理器。
func (r *apiRouter) Redirect(method, path string) {
	if r.owner != nil {
		r.owner.canonicalRedirect(method, normalizeAPIPath(r.prefix+path))
	}
}

// flush 为收集到的路由绑定 GoFrame 处理器；必须在所有注册完成后调用。
// 同时把路由表挂到 Controller，供 method guard 做 405 判定。
func (r *apiRouter) flush() *routeTable {
	table := &routeTable{entries: make([]*routeEntry, 0, len(r.routes))}
	for _, entry := range r.routes {
		entry := entry
		table.entries = append(table.entries, entry)
		pattern := entry.method + ":" + entry.base
		if entry.fuzzy != nil {
			pattern += "/*"
		}
		r.server.BindHandler(pattern, entry.dispatch())
	}
	if r.owner != nil {
		r.owner.routes = table
	}
	return table
}

// routeTable 是应用自己维护的路由索引，用于在静态兜底与业务处理器
// 之前判定 405。GoFrame 的 RegRule 未锚定且会跳过通配路由，不适合。
type routeTable struct {
	entries []*routeEntry
}

// matches 报告该方法是否可以处理该路径。
func (t *routeTable) matches(method, path string) bool {
	if t == nil {
		return true
	}
	for _, entry := range t.entries {
		if entry.method == method && entry.matches(path) {
			return true
		}
	}
	return false
}

// allowed 返回该路径已注册的方法（按稳定顺序）。
func (t *routeTable) allowed(path string) []string {
	if t == nil {
		return nil
	}
	present := make(map[string]struct{})
	for _, entry := range t.entries {
		if entry.matches(path) {
			present[entry.method] = struct{}{}
		}
	}
	methods := make([]string, 0, len(present))
	for _, method := range []string{
		http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete,
	} {
		if _, ok := present[method]; ok {
			methods = append(methods, method)
		}
	}
	return methods
}

func (e *routeEntry) matches(path string) bool {
	if matchPathPattern(e.base, path) {
		return true
	}
	if e.fuzzy == nil {
		return false
	}
	baseParts := splitPath(e.base)
	targetParts := splitPath(path)
	if len(targetParts) <= len(baseParts) {
		return false
	}
	for index, part := range baseParts {
		if !matchPathSegment(part, targetParts[index]) {
			return false
		}
	}
	return true
}

func (e *routeEntry) dispatch() ghttp.HandlerFunc {
	return func(r *ghttp.Request) {
		raw := requestPath(r)
		if matchPathPattern(e.base, raw) {
			if hasTrailingSlash(raw) && e.slash != nil {
				e.slash(r)
				return
			}
			if e.exact != nil {
				e.exact(r)
				return
			}
			if e.slash != nil {
				e.slash(r)
				return
			}
		}
		switch {
		case e.fuzzy != nil:
			e.fuzzy(r)
		case e.exact != nil:
			e.exact(r)
		case e.slash != nil:
			e.slash(r)
		}
	}
}

// readRoute 是 Spring @GetMapping 的 Go 等价物：一次声明同时提供
// GET 与既有 Java 契约要求的 HEAD。
func readRoute(api *apiRouter, path string, handler ghttp.HandlerFunc) {
	api.GET(path, handler)
	api.HEAD(path, handler)
}

func normalizeAPIPath(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	for strings.Contains(path, "//") {
		path = strings.ReplaceAll(path, "//", "/")
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	return path
}

func requestPath(r *ghttp.Request) string {
	path := r.RequestURI
	if path == "" {
		return r.URL.Path
	}
	if index := strings.IndexByte(path, '?'); index >= 0 {
		path = path[:index]
	}
	return path
}

func hasTrailingSlash(path string) bool {
	return len(path) > 1 && strings.HasSuffix(path, "/")
}

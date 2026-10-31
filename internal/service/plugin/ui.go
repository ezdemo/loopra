package plugin

import (
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/repository"
)

//go:embed bridge.js
var uiBridgeJS []byte

// UIBridgeRel 是宿主桥的路径。插件目录里的同名文件不会被发出去。
const UIBridgeRel = "_loopra/bridge.js"

// UICookie 只用于打开某一个插件的设置页，不是访问密钥。
const UICookie = "loopra_plugin_ui"

// UIConfigLimit 是插件设置 JSON 的上限。
const UIConfigLimit = 64 * 1024

const uiTicketTTL = time.Hour

type uiTicket struct {
	plugin string
	exp    time.Time
}

var uiTickets = struct {
	sync.Mutex
	items map[string]uiTicket
}{items: map[string]uiTicket{}}

// SplitPluginUI 从 /api/plugins 之后的路径取出插件 id、页面槽和相对路径。
// 槽是 ui、sidebar、menu 或 panel。id/ui 是入口页，id/ui/app.css 是入口目录里的文件。
// id/ui/t/<票据>/app.css 是同一份文件，票据写在路径里，沙箱页的子资源不必带 cookie。
func SplitPluginUI(path string) (id, slot, rel string, ok bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 || (parts[1] != "ui" && parts[1] != "sidebar" && parts[1] != "menu" && parts[1] != "panel") || !safeID(parts[0]) {
		return "", "", "", false
	}
	relParts := parts[2:]
	if len(relParts) >= 2 && relParts[0] == "t" {
		if owner, found := uiTicketOwner(relParts[1]); found && owner == parts[0] {
			relParts = relParts[2:]
		}
	}
	return parts[0], parts[1], strings.Join(relParts, "/"), true
}

// UIPagePath 是打开页面后 iframe 要加载的路径，相对于 /api。
func UIPagePath(id, slot, token string) string {
	return "/plugins/" + id + "/" + slot + "/t/" + token + "/"
}

// IsUIBridge 判断相对路径是不是宿主桥。
func IsUIBridge(rel string) bool {
	return rel == UIBridgeRel || strings.HasSuffix(rel, "/"+UIBridgeRel)
}

// UIPathHasTicket 报告这条页面路径是否带着仍有效、且属于该插件的票据。
func UIPathHasTicket(path string) bool {
	id, _, _, ok := SplitPluginUI(strings.TrimPrefix(path, "/api/plugins"))
	return ok && uiPathTicket(path, id)
}

// IssueUITicket 签发一小时内有效、只对应这一个插件的设置页票据。
func IssueUITicket(id string) (string, error) {
	if !safeID(id) {
		return "", errMissing(id)
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	uiTickets.Lock()
	defer uiTickets.Unlock()
	now := time.Now()
	pruneTicketsLocked(now)
	uiTickets.items[token] = uiTicket{plugin: id, exp: now.Add(uiTicketTTL)}
	return token, nil
}

// ValidUIRequest 只放行带对应该插件票据的设置页 GET/HEAD。
// 票据可以在 cookie 里，也可以在 /t/<票据>/ 路径里。路径票据给沙箱页的样式表和脚本用：
// 不透明源不会带上 SameSite=Lax 的 cookie。
func ValidUIRequest(r *http.Request) bool {
	if r == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	id, _, _, ok := SplitPluginUI(strings.TrimPrefix(r.URL.Path, "/api/plugins"))
	if !ok {
		return false
	}
	if uiPathTicket(r.URL.Path, id) {
		return true
	}
	cookie, err := r.Cookie(UICookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	owner, found := uiTicketOwner(cookie.Value)
	return found && owner == id
}

func uiTicketOwner(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	uiTickets.Lock()
	defer uiTickets.Unlock()
	now := time.Now()
	pruneTicketsLocked(now)
	ticket, ok := uiTickets.items[token]
	if !ok || !ticket.exp.After(now) {
		delete(uiTickets.items, token)
		return "", false
	}
	return ticket.plugin, true
}

func uiPathTicket(path, id string) bool {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(path, "/api/plugins"), "/"), "/")
	if len(parts) < 4 || parts[0] != id || parts[2] != "t" {
		return false
	}
	owner, ok := uiTicketOwner(parts[3])
	return ok && owner == id
}

// WriteUIBridge 写出宿主桥。
func WriteUIBridge(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	if r != nil && r.Method == http.MethodHead {
		w.Header().Set("Content-Length", strconv.Itoa(len(uiBridgeJS)))
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(uiBridgeJS)
}

// InjectUIBridge 在 HTML 里加上宿主桥。页面自己已经引用时不再加第二遍。
func InjectUIBridge(html []byte) []byte {
	if bytes.Contains(html, []byte(UIBridgeRel)) {
		return html
	}
	tag := []byte(`<script src="` + UIBridgeRel + `"></script>`)
	lower := bytes.ToLower(html)
	if i := bytes.Index(lower, []byte("<head>")); i >= 0 {
		i += len("<head>")
		out := make([]byte, 0, len(html)+len(tag))
		out = append(out, html[:i]...)
		out = append(out, tag...)
		return append(out, html[i:]...)
	}
	if i := bytes.Index(lower, []byte("<head ")); i >= 0 {
		if j := bytes.IndexByte(html[i:], '>'); j >= 0 {
			at := i + j + 1
			out := make([]byte, 0, len(html)+len(tag))
			out = append(out, html[:at]...)
			out = append(out, tag...)
			return append(out, html[at:]...)
		}
	}
	return append(tag, html...)
}

func pruneTicketsLocked(now time.Time) {
	for token, ticket := range uiTickets.items {
		if !ticket.exp.After(now) {
			delete(uiTickets.items, token)
		}
	}
}

// Installed 报告清单里是否有这个插件。
func (h *Host) Installed(id string) bool {
	return h != nil && h.knownPlugin(id) == nil
}

func (h *Host) knownPlugin(id string) error {
	if h == nil || !safeID(id) {
		return errMissing(id)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, rec := range h.records {
		if rec.ID == id {
			return nil
		}
	}
	return errMissing(id)
}

// SettingsFile 返回设置页入口，或入口目录内的一个静态文件。
// 入口目录之外的路径、符号链接和未允许的文件类型都拒绝。
func (h *Host) SettingsFile(id, rel string) (string, error) {
	return h.pageFile(id, "ui", rel)
}

// SidebarFile 返回侧栏页面入口，或入口目录内的一个静态文件。
func (h *Host) SidebarFile(id, rel string) (string, error) {
	return h.pageFile(id, "sidebar", rel)
}

// PanelFile returns a plugin's tab in the right workbench panel.
func (h *Host) PanelFile(id, rel string) (string, error) {
	return h.pageFile(id, "panel", rel)
}

// SidebarTitle 在声明了侧栏页面时返回按钮标题，否则返回空字符串。
func (h *Host) SidebarTitle(id, fallback string) string {
	if _, err := h.pageFile(id, "sidebar", ""); err != nil {
		return ""
	}
	title := clipLabel(readPkg(h.pkgDir(id)).SidebarTitle)
	if title == "" {
		title = clipLabel(fallback)
	}
	return title
}

// MenuFile 返回设置菜单页面。有子菜单时，rel 的第一段是子菜单 id。
func (h *Host) MenuFile(id, rel string) (string, error) {
	if h == nil || !safeID(id) {
		return "", errText("这个插件没有设置菜单")
	}
	info := readPkg(h.pkgDir(id))
	if len(info.MenuChildren) > 0 {
		childID, rest, _ := strings.Cut(rel, "/")
		for _, child := range info.MenuChildren {
			if child.ID == childID {
				return h.entryFile(id, child.Page, rest, "这个插件没有设置菜单")
			}
		}
		return "", errText("这个插件没有设置菜单")
	}
	return h.entryFile(id, info.MenuPage, rel, "这个插件没有设置菜单")
}

// MenuOpenPath 是打开菜单时用来确认页面存在的相对路径。
func (h *Host) MenuOpenPath(id string) string {
	if h == nil || !safeID(id) {
		return ""
	}
	info := readPkg(h.pkgDir(id))
	if len(info.MenuChildren) > 0 {
		return info.MenuChildren[0].ID
	}
	return ""
}

// IconFile 返回插件声明的一张图片。key 是 plugin、sidebar、menu 或 item-<子菜单 id>。
func (h *Host) IconFile(id, key string) (string, error) {
	if h == nil || !safeID(id) || !validIconKey(key) {
		return "", errText("图标不存在")
	}
	info := readPkg(h.pkgDir(id))
	rel := ""
	switch key {
	case "plugin":
		rel = info.Icon.File
	case "sidebar":
		rel = info.SidebarIcon.File
	case "panel":
		rel = info.PanelIcon.File
	case "menu":
		rel = info.MenuIcon.File
	default:
		if childID, ok := strings.CutPrefix(key, "item-"); ok {
			for _, child := range info.MenuChildren {
				if child.ID == childID {
					rel = child.Icon.File
					break
				}
			}
		}
	}
	if rel == "" {
		return "", errText("图标不存在")
	}
	return h.imageFile(id, rel)
}

func (h *Host) iconRef(id, key string, icon, fallback pkgIcon) *IconRef {
	if icon.Hidden || (icon.Name == "" && icon.File == "" && fallback.Hidden) {
		return &IconRef{Hidden: true}
	}
	if icon.Name != "" {
		return &IconRef{Name: icon.Name}
	}
	if icon.File != "" {
		if _, err := h.imageFile(id, icon.File); err == nil {
			return &IconRef{Key: key}
		}
	}
	if fallback.Name != "" {
		return &IconRef{Name: fallback.Name}
	}
	if fallback.File != "" {
		if _, err := h.imageFile(id, fallback.File); err == nil {
			return &IconRef{Key: "plugin"}
		}
	}
	return nil
}

func (h *Host) pageFile(id, slot, rel string) (string, error) {
	missing := "这个插件没有设置页"
	if slot == "sidebar" {
		missing = "这个插件没有侧栏页面"
	} else if slot == "panel" {
		missing = "这个插件没有右侧面板"
	} else if slot != "ui" {
		return "", errText("设置页路径无效")
	}
	if h == nil || !safeID(id) {
		return "", errText(missing)
	}
	info := readPkg(h.pkgDir(id))
	entry := info.Settings
	if slot == "sidebar" {
		entry = info.Sidebar
	} else if slot == "panel" {
		entry = info.Panel
	}
	return h.entryFile(id, entry, rel, missing)
}

func (h *Host) entryFile(id, entry, rel, missing string) (string, error) {
	entryRel, err := cleanPluginPath(entry)
	if err != nil || entryRel == "" {
		return "", errText(missing)
	}
	pkgRoot, err := filepath.EvalSymlinks(h.pkgDir(id))
	if err != nil {
		return "", errText(missing)
	}
	entryPath, err := resolveInside(pkgRoot, pkgRoot, entryRel)
	if err != nil {
		return "", errText(missing)
	}
	root := filepath.Dir(entryPath)
	target := entryPath
	if rel != "" {
		target, err = resolveInside(pkgRoot, root, rel)
		if err != nil {
			return "", errText("设置页路径无效")
		}
	}
	stat, err := os.Stat(target)
	if err != nil || !stat.Mode().IsRegular() {
		return "", errText("设置页路径无效")
	}
	if _, ok := UIContentType(target); !ok {
		return "", errText("设置页路径无效")
	}
	return target, nil
}

func (h *Host) imageFile(id, rel string) (string, error) {
	if h == nil || !safeID(id) {
		return "", errText("图标不存在")
	}
	cleaned, err := cleanPluginPath(rel)
	if err != nil || cleaned == "" {
		return "", errText("图标不存在")
	}
	pkgRoot, err := filepath.EvalSymlinks(h.pkgDir(id))
	if err != nil {
		return "", errText("图标不存在")
	}
	target, err := resolveInside(pkgRoot, pkgRoot, cleaned)
	if err != nil {
		return "", errText("图标不存在")
	}
	stat, err := os.Stat(target)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 256<<10 || !imageType(target) {
		return "", errText("图标不存在")
	}
	return target, nil
}

func validIconKey(key string) bool {
	switch key {
	case "plugin", "sidebar", "menu", "panel":
		return true
	}
	child, ok := strings.CutPrefix(key, "item-")
	return ok && safeID(child) && child != "open" && child != "icons"
}

func (h *Host) menuView(id, fallback string) *MenuView {
	info := readPkg(h.pkgDir(id))
	if len(info.MenuChildren) == 0 && strings.TrimSpace(info.MenuPage) == "" {
		return nil
	}
	title := clipLabel(info.MenuTitle)
	if title == "" {
		title = clipLabel(fallback)
	}
	if title == "" {
		return nil
	}
	icon := h.iconRef(id, "menu", info.MenuIcon, info.Icon)
	if len(info.MenuChildren) > 0 {
		items := make([]MenuItem, 0, len(info.MenuChildren))
		for _, child := range info.MenuChildren {
			if _, err := h.MenuFile(id, child.ID); err != nil {
				continue
			}
			items = append(items, MenuItem{
				ID: child.ID, Title: clipLabel(child.Title),
				Icon: h.iconRef(id, "item-"+child.ID, child.Icon, info.Icon),
			})
		}
		if len(items) == 0 {
			return nil
		}
		return &MenuView{Title: title, Category: info.MenuCategory, Icon: icon, Children: items}
	}
	if _, err := h.MenuFile(id, ""); err != nil {
		return nil
	}
	return &MenuView{Title: title, Category: info.MenuCategory, Icon: icon, Page: true}
}

func imageType(file string) bool {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif":
		return true
	default:
		return false
	}
}

func clipLabel(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 40 {
		return string(runes[:40])
	}
	return value
}

func resolveInside(pkgRoot, root, rel string) (string, error) {
	cleaned, err := cleanPluginPath(rel)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(root, filepath.FromSlash(cleaned))
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil || !inside(pkgRoot, resolved) || !inside(root, resolved) {
		return "", errText("设置页路径无效")
	}
	return resolved, nil
}

func cleanPluginPath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) || strings.Contains(value, ":") {
		return "", errText("设置页路径无效")
	}
	for strings.HasPrefix(value, "./") {
		value = strings.TrimPrefix(value, "./")
	}
	if strings.HasPrefix(value, "/") {
		return "", errText("设置页路径无效")
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == "" || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errText("设置页路径无效")
	}
	return cleaned, nil
}

// UIContentType 只允许设置页会用到的静态类型。
func UIContentType(file string) (string, bool) {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8", true
	case ".css":
		return "text/css; charset=utf-8", true
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8", true
	case ".svg":
		return "image/svg+xml", true
	case ".png":
		return "image/png", true
	case ".jpg", ".jpeg":
		return "image/jpeg", true
	case ".webp":
		return "image/webp", true
	case ".gif":
		return "image/gif", true
	case ".woff":
		return "font/woff", true
	case ".woff2":
		return "font/woff2", true
	default:
		return "", false
	}
}

// requestDir 是浏览器眼里这一页所在的目录。优先用原始请求路径。
// 路由有时会拿掉目录地址末尾的斜杠；HTML 不是以 .html 结尾时，整段路径就是目录。
func requestDir(r *http.Request) string {
	dir := "/"
	if r == nil {
		return dir
	}
	raw := r.RequestURI
	if raw == "" && r.URL != nil {
		raw = r.URL.RequestURI()
	}
	if cut := strings.IndexByte(raw, '?'); cut >= 0 {
		raw = raw[:cut]
	}
	if raw == "" && r.URL != nil {
		raw = r.URL.Path
	}
	if raw == "" {
		return dir
	}
	if !strings.HasPrefix(raw, "/") {
		raw = "/" + raw
	}
	lower := strings.ToLower(raw)
	if strings.HasSuffix(lower, ".html") || strings.HasSuffix(lower, ".htm") {
		if cut := strings.LastIndex(raw, "/"); cut >= 0 {
			return raw[:cut+1]
		}
	}
	if !strings.HasSuffix(raw, "/") {
		raw += "/"
	}
	return raw
}

// UIContentSecurityPolicy 禁止设置页请求接口。
// 脚本、样式、图片和字体可以来自这一页自己的目录。内联样式和脚本仍然可用。
// 源写成路径，沙箱页的不透明源对不上 'self'。
func UIContentSecurityPolicy(r *http.Request) string {
	dir := requestDir(r)
	sources := dir
	if r != nil && r.Host != "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		if proto := r.Header.Get("X-Forwarded-Proto"); proto == "https" || proto == "http" {
			scheme = proto
		}
		sources = dir + " " + scheme + "://" + r.Host + dir
	}
	return "default-src 'none'; script-src 'unsafe-inline' " + sources +
		"; style-src 'unsafe-inline' " + sources +
		"; img-src data: " + sources +
		"; font-src " + sources +
		"; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
}

func (h *Host) uiConfigPath(id string) string {
	return filepath.Join(h.home, "plugins", "ui-config", id+".json")
}

// UIConfig 读取插件自己的设置。没有文件时是空对象。
func (h *Host) UIConfig(id string) (map[string]any, error) {
	if err := h.knownPlugin(id); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(h.uiConfigPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if len(data) > UIConfigLimit {
		return nil, errText("插件配置过大")
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil || obj == nil {
		return map[string]any{}, nil
	}
	return obj, nil
}

// SetUIConfig 保存插件设置。值必须是对象，序列化后不超过 64 KiB。
func (h *Host) SetUIConfig(id string, value map[string]any) error {
	if err := h.knownPlugin(id); err != nil {
		return err
	}
	if value == nil {
		return errText("插件配置必须是对象")
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > UIConfigLimit {
		return errText("插件配置过大")
	}
	return repository.WriteJSON(h.uiConfigPath(id), value)
}

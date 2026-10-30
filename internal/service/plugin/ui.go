package plugin

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/repository"
)

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
// 槽是 ui 或 sidebar。id/ui 是入口页，id/ui/app.css 是入口目录里的文件。
func SplitPluginUI(path string) (id, slot, rel string, ok bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 || (parts[1] != "ui" && parts[1] != "sidebar" && parts[1] != "menu") || !safeID(parts[0]) {
		return "", "", "", false
	}
	return parts[0], parts[1], strings.Join(parts[2:], "/"), true
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
func ValidUIRequest(r *http.Request) bool {
	if r == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	id, _, _, ok := SplitPluginUI(strings.TrimPrefix(r.URL.Path, "/api/plugins"))
	if !ok {
		return false
	}
	cookie, err := r.Cookie(UICookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	uiTickets.Lock()
	defer uiTickets.Unlock()
	ticket, ok := uiTickets.items[cookie.Value]
	if !ok || !ticket.exp.After(time.Now()) || ticket.plugin != id {
		delete(uiTickets.items, cookie.Value)
		return false
	}
	return true
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
	case "plugin", "sidebar", "menu":
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
		return &MenuView{Title: title, Icon: icon, Children: items}
	}
	if _, err := h.MenuFile(id, ""); err != nil {
		return nil
	}
	return &MenuView{Title: title, Icon: icon, Page: true}
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

// UIContentSecurityPolicy 禁止设置页请求接口。
// 样式和脚本只允许写在页面里：沙箱页面是不透明源，单独的样式表和脚本不会生效。
func UIContentSecurityPolicy(_ *http.Request, _ string) string {
	return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
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

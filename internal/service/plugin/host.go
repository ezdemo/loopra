// Package plugin 用 moejs 运行从 npm 或 GitHub 安装的 JavaScript / TypeScript 插件。
//
// 插件是一个 ES 模块。两种写法都能被识别：
//
//	export function greet(args: { name?: string }) {
//	  return { text: `hello ${args.name ?? "world"}` };
//	}
//
//	export function tools() {
//	  return [{ name: "greet", description: "打招呼", readOnly: true, parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];
//	}
//	export function call(input: { name: string, args: { name?: string } }) {
//	  return { text: `hello ${input.args.name ?? "world"}` };
//	}
//
// 入口优先用 package.json 的 loopra（字符串或 {plugin}），其次 module、main，
// 再其次 plugin.ts / plugin.js / index.ts / index.js。函数可以是 async，宿主会等
// 返回的 Promise。运行时安装 moejs 的 Web API 和 node:fs / node:fs/promises /
// node:buffer：fetch 不按主机名拦截，文件读写不另加路径白名单。插件自己的
// import 仍然只能引用插件目录和随包依赖，也不能使用动态代码。
//
// 钩子是可选导出，可以和工具写在同一个模块里，也可以只有钩子。名字是
// turnBefore、systemPrompt、llmRequest、llmResponse、toolBefore、toolAfter、
// compact、turnAfter。宿主按安装顺序调用，前一个的返回值会交给下一个；
// 某个插件抛错时跳过它，不中断这一轮。
package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/repository"
)

// View 是设置页和 /api/plugins 使用的插件清单项。
type View struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	Description string   `json:"description,omitempty"`
	Remark      string   `json:"remark,omitempty"`
	Version     string   `json:"version,omitempty"`
	Source      string   `json:"source"`
	SourceURL   string   `json:"sourceUrl,omitempty"`
	Enabled     bool     `json:"enabled"`
	State       string   `json:"state,omitempty"`
	Error       string   `json:"error,omitempty"`
	Tools       []string `json:"tools,omitempty"`
	Hooks       []string `json:"hooks,omitempty"`
	Entry       string   `json:"entry,omitempty"`
}

// Hooks 把插件工具挂进宿主的工具注册表。回调不能反过来调用 Host 的安装方法。
type Hooks struct {
	Bind   func([]BoundTool)
	Unbind func([]string)
}

type record struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version,omitempty"`
	Source      string `json:"source"`
	Entry       string `json:"entry,omitempty"`
	Enabled     bool   `json:"enabled"`
	InstalledAt int64  `json:"installedAt"`
}

// Host 管理已安装插件、清单和 moejs 运行时。
// Fetcher 非空时替代 HTTPS 下载，测试用它注入安装包。
type Host struct {
	mu      sync.Mutex
	op      sync.Mutex
	home    string
	client  *http.Client
	bind    func([]BoundTool)
	unbind  func([]string)
	loaded  map[string]*running
	errors  map[string]string
	records []record
	ready   bool
	Fetcher func(ctx context.Context, rawURL string) ([]byte, error)
}

// New 打开 home/plugins 下的清单。LoadEnabled 才会编译并挂上工具。
func New(home string, hooks Hooks) *Host {
	h := &Host{
		home: home, client: newClient(), bind: hooks.Bind, unbind: hooks.Unbind,
		loaded: map[string]*running{}, errors: map[string]string{},
	}
	h.mu.Lock()
	h.ensureManifest()
	h.mu.Unlock()
	return h
}

// LoadEnabled 编译清单里已启用的插件。单个插件失败只记录错误，不阻止启动。
func (h *Host) LoadEnabled(ctx context.Context) {
	if h == nil || h.home == "" {
		return
	}
	h.mu.Lock()
	h.ensureManifest()
	recs := append([]record(nil), h.records...)
	h.mu.Unlock()
	for _, rec := range recs {
		if !rec.Enabled {
			continue
		}
		if err := h.reload(ctx, rec); err != nil {
			logging.Warnf("plugin", "load %s: %v", rec.ID, err)
		}
	}
}

// List 返回已安装插件。没有插件时是空数组。
func (h *Host) List() []View {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureManifest()
	out := make([]View, 0, len(h.records))
	for _, rec := range h.records {
		out = append(out, h.viewLocked(rec))
	}
	return out
}

// Bound 返回当前已启用且加载成功的工具，供新建的工作区注册表挂载。
func (h *Host) Bound() []BoundTool {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []BoundTool
	for _, rec := range h.records {
		if !rec.Enabled {
			continue
		}
		if run := h.loaded[rec.ID]; run != nil {
			out = append(out, run.bound...)
		}
	}
	return out
}

// Install 安装 npm 包、GitHub 仓库或本地目录、压缩包、单个模块，编译入口并挂上它导出的工具。
func (h *Host) Install(ctx context.Context, source string) (View, error) {
	if h.home == "" {
		return View{}, errNoHome
	}
	h.op.Lock()
	defer h.op.Unlock()
	parsed, err := parseSource(source)
	if err != nil {
		return View{}, err
	}
	if err := os.MkdirAll(h.base(), 0o755); err != nil {
		return View{}, err
	}
	stage, err := os.MkdirTemp(h.base(), ".stage-")
	if err != nil {
		return View{}, err
	}
	defer os.RemoveAll(stage)
	info, err := h.materialize(ctx, parsed, stage)
	if err != nil {
		return View{}, err
	}
	id := pluginID(info.Name)
	if !safeID(id) {
		return View{}, errBadID
	}
	if err := h.swapDir(stage, h.pkgDir(id)); err != nil {
		return View{}, err
	}
	rec := record{
		ID: id, Name: info.Name, DisplayName: info.Name, Description: info.Description,
		Version: info.Version, Source: parsed.Display, Entry: info.Entry,
		Enabled: true, InstalledAt: time.Now().UnixMilli(),
	}
	if rec.DisplayName == "" {
		rec.DisplayName = id
	}
	if err := h.upsert(rec); err != nil {
		return View{}, err
	}
	if err := h.reload(ctx, rec); err != nil {
		return View{}, err
	}
	return h.view(id), nil
}

// SetEnabled 启用或停用插件。启用时会重新编译。
func (h *Host) SetEnabled(ctx context.Context, id string, enabled bool) (View, error) {
	if !safeID(id) {
		return View{}, errMissing(id)
	}
	h.op.Lock()
	defer h.op.Unlock()
	h.mu.Lock()
	h.ensureManifest()
	idx := -1
	for i := range h.records {
		if h.records[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		h.mu.Unlock()
		return View{}, errMissing(id)
	}
	h.records[idx].Enabled = enabled
	rec := h.records[idx]
	err := h.saveLocked()
	h.mu.Unlock()
	if err != nil {
		return View{}, err
	}
	if !enabled {
		h.drop(id)
		return h.view(id), nil
	}
	if err := h.reload(ctx, rec); err != nil {
		return h.view(id), err
	}
	return h.view(id), nil
}

// Remove 卸载插件、删除文件，并摘掉它贡献的工具。
func (h *Host) Remove(id string) error {
	if !safeID(id) {
		return errMissing(id)
	}
	h.op.Lock()
	defer h.op.Unlock()
	h.mu.Lock()
	h.ensureManifest()
	next := make([]record, 0, len(h.records))
	found := false
	for _, rec := range h.records {
		if rec.ID == id {
			found = true
			continue
		}
		next = append(next, rec)
	}
	if !found {
		h.mu.Unlock()
		return errMissing(id)
	}
	h.records = next
	err := h.saveLocked()
	h.mu.Unlock()
	h.drop(id)
	if removeErr := os.RemoveAll(h.pkgDir(id)); err == nil {
		err = removeErr
	}
	return err
}

func (h *Host) reload(ctx context.Context, rec record) error {
	run, err := openPackage(ctx, h.pkgDir(rec.ID), rec)
	h.mu.Lock()
	old := h.loaded[rec.ID]
	var oldNames []string
	if old != nil {
		oldNames = append([]string(nil), old.names...)
	}
	if err != nil {
		h.errors[rec.ID] = err.Error()
		delete(h.loaded, rec.ID)
		h.mu.Unlock()
		old.close()
		if len(oldNames) > 0 && h.unbind != nil {
			h.unbind(oldNames)
		}
		return err
	}
	delete(h.errors, rec.ID)
	if run.displayName != "" {
		rec.DisplayName = run.displayName
	}
	if run.description != "" {
		rec.Description = run.description
	}
	if run.entry != "" {
		rec.Entry = run.entry
	}
	for i := range h.records {
		if h.records[i].ID == rec.ID {
			rec.Enabled = h.records[i].Enabled
			rec.InstalledAt = h.records[i].InstalledAt
			if h.records[i].Source != "" {
				rec.Source = h.records[i].Source
			}
			h.records[i] = rec
			break
		}
	}
	if saveErr := h.saveLocked(); saveErr != nil {
		h.mu.Unlock()
		return saveErr
	}
	h.loaded[rec.ID] = run
	h.mu.Unlock()
	old.close()
	if len(oldNames) > 0 && h.unbind != nil {
		h.unbind(oldNames)
	}
	if h.bind != nil {
		h.bind(run.bound)
	}
	return nil
}

func (h *Host) drop(id string) {
	h.mu.Lock()
	run := h.loaded[id]
	delete(h.loaded, id)
	delete(h.errors, id)
	var names []string
	if run != nil {
		names = append([]string(nil), run.names...)
	}
	h.mu.Unlock()
	run.close()
	if len(names) > 0 && h.unbind != nil {
		h.unbind(names)
	}
}

func (h *Host) view(id string) View {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, rec := range h.records {
		if rec.ID == id {
			return h.viewLocked(rec)
		}
	}
	return View{ID: id, DisplayName: id}
}

func (h *Host) viewLocked(rec record) View {
	view := View{
		ID: rec.ID, DisplayName: rec.DisplayName, Description: rec.Description, Remark: rec.Description,
		Version: rec.Version, Source: rec.Source, SourceURL: rec.Source, Enabled: rec.Enabled,
		Entry: rec.Entry, State: "已停用",
	}
	if view.DisplayName == "" {
		view.DisplayName = rec.Name
	}
	if view.DisplayName == "" {
		view.DisplayName = rec.ID
	}
	if run := h.loaded[rec.ID]; run != nil {
		view.Tools = append([]string(nil), run.names...)
		view.Hooks = run.hookNames()
	}
	if msg := h.errors[rec.ID]; msg != "" {
		view.Error = msg
		view.State = "加载失败"
		view.Remark = msg
		if view.Description == "" {
			view.Description = msg
		}
	} else if rec.Enabled {
		view.State = "已启用"
	}
	return view
}

func (h *Host) upsert(rec record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureManifest()
	replaced := false
	for i := range h.records {
		if h.records[i].ID == rec.ID {
			if rec.InstalledAt == 0 {
				rec.InstalledAt = h.records[i].InstalledAt
			}
			h.records[i] = rec
			replaced = true
			break
		}
	}
	if !replaced {
		h.records = append(h.records, rec)
	}
	return h.saveLocked()
}

func (h *Host) ensureManifest() {
	if h.ready {
		return
	}
	h.ready = true
	var doc struct {
		Plugins []record `json:"plugins"`
	}
	data, err := os.ReadFile(h.manifestPath())
	if err != nil {
		return
	}
	if json.Unmarshal(data, &doc) != nil {
		return
	}
	h.records = doc.Plugins
}

func (h *Host) saveLocked() error {
	doc := struct {
		Plugins []record `json:"plugins"`
	}{Plugins: h.records}
	if doc.Plugins == nil {
		doc.Plugins = []record{}
	}
	return repository.WriteJSON(h.manifestPath(), doc)
}

func (h *Host) base() string { return filepath.Join(h.home, "plugins") }

func (h *Host) pkgDir(id string) string {
	return filepath.Join(h.home, "plugins", "packages", id)
}

func (h *Host) manifestPath() string {
	return filepath.Join(h.home, "plugins", "installed.json")
}

func (h *Host) swapDir(stage, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	backup := dest + ".bak"
	_ = os.RemoveAll(backup)
	if _, err := os.Stat(dest); err == nil {
		if err := os.Rename(dest, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(stage, dest); err != nil {
		_ = os.Rename(backup, dest)
		return err
	}
	return os.RemoveAll(backup)
}

func safeID(id string) bool {
	if id == "" || len(id) > 64 || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

func errMissing(id string) error { return errText("插件不存在: " + id) }

type errText string

func (e errText) Error() string { return string(e) }

const (
	errNoHome errText = "插件目录不可用"
	errBadID  errText = "无法从包名生成插件标识"
)

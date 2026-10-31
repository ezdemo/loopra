//go:build !386 && !arm

package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/MoeForge/moejs"
	"github.com/MoeForge/moejs/eventloop"
	"github.com/MoeForge/moejs/node"
	"github.com/MoeForge/moejs/webapi"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
)

// BoundTool 是一个已经绑定到 moejs 导出函数的工具。
type BoundTool struct {
	Name        string
	Description string
	ReadOnly    bool
	Chat        bool
	Parameters  json.RawMessage
	Call        func(ctx context.Context, args map[string]any) (map[string]any, error)
}

type running struct {
	callContext  context.Context
	gate         chan struct{}
	closeOnce    sync.Once
	rt           *moejs.Runtime
	loop         *eventloop.Loop
	node         *node.API
	web          *webapi.API
	names        []string
	bound        []BoundTool
	hooks        map[string]moejs.Hook
	hookPriority map[string]int
	requestHook  *moejs.Hook
	closed       bool
	displayName  string
	description  string
	entry        string
}

type toolBinding struct {
	short   string
	hook    moejs.Hook
	viaCall bool
}

type toolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	ReadOnly    bool            `json:"readOnly"`
	Chat        bool            `json:"chat"`
	Expose      string          `json:"expose"`
	Parameters  json.RawMessage `json:"parameters"`
}

type modCache struct {
	root string
	ctx  context.Context
	mu   sync.Mutex
	mods map[string]*moejs.Module
}

func openPackage(ctx context.Context, dir string, rec record) (*running, error) {
	entry, err := findEntry(dir, rec.Entry)
	if err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(filepath.Join(dir, entry))
	if err != nil {
		return nil, err
	}
	cache := &modCache{root: dir, ctx: ctx, mods: map[string]*moejs.Module{}}
	entryMod, err := cache.compile(abs)
	if err != nil {
		return nil, jsError(err)
	}
	linked, err := moejs.Link(entryMod, node.Resolver(cache.resolve))
	if err != nil {
		return nil, jsError(err)
	}
	run, err := newHostRuntime(cache)
	if err != nil {
		return nil, err
	}
	discard := run
	defer func() {
		if discard != nil {
			discard.close()
		}
	}()
	if err := run.rt.SetGlobal("console", consoleObject(rec.ID)); err != nil {
		return nil, err
	}
	if err := run.run(ctx, func(rt *moejs.Runtime) error {
		err := rt.Load(linked)
		if errors.Is(err, moejs.ErrModulePending) {
			return nil
		}
		return err
	}); err != nil {
		return nil, jsError(err)
	}
	display, description, priority := readMeta(run.rt)
	run.hookPriority = priority
	if display == "" {
		display = rec.DisplayName
	}
	if display == "" {
		display = rec.Name
	}
	run.displayName = display
	run.description = description
	run.entry = entry
	defs, explicit, err := readToolDefs(run.rt, linked)
	if err != nil {
		return nil, jsError(err)
	}
	callHook, hasCall, err := findCall(run.rt, linked)
	if err != nil {
		return nil, jsError(err)
	}
	hooks, err := collectHooks(run.rt, linked)
	if err != nil {
		return nil, jsError(err)
	}
	run.hooks = hooks
	requestHook, hasRequest, err := findHandler(run.rt, linked, "onRequest")
	if err != nil {
		return nil, jsError(err)
	}
	if hasRequest {
		run.requestHook = &requestHook
	}
	if err := bindTools(run, rec.ID, display, defs, explicit, callHook, hasCall, linked, run.rt); err != nil {
		return nil, err
	}
	if len(run.bound) == 0 && len(run.hooks) == 0 && !hasRequest {
		return nil, fmt.Errorf("插件没有导出工具、钩子或 onRequest")
	}
	discard = nil
	return run, nil
}

func (c *modCache) resolve(ref moejs.Referrer, spec string) (*moejs.Module, error) {
	from := c.root
	if ref != nil && ref.Name() != "" {
		from = filepath.Dir(ref.Name())
	}
	file, err := locate(c.root, from, spec)
	if err != nil {
		return nil, err
	}
	return c.compile(file)
}

func (c *modCache) compile(file string) (*moejs.Module, error) {
	file = filepath.Clean(file)
	if !inside(c.root, file) {
		return nil, fmt.Errorf("导入越出插件目录")
	}
	rel, err := filepath.Rel(c.root, file)
	if err != nil {
		return nil, err
	}
	safe, err := fsutil.SafeJoin(c.root, rel)
	if err != nil {
		return nil, fmt.Errorf("导入越出插件目录")
	}
	c.mu.Lock()
	if mod, ok := c.mods[safe]; ok {
		c.mu.Unlock()
		return mod, nil
	}
	c.mu.Unlock()
	info, err := os.Stat(safe)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, fmt.Errorf("%s 超过 1 MiB 或不是文件", rel)
	}
	data, err := os.ReadFile(safe)
	if err != nil {
		return nil, err
	}
	mod, err := compileFile(c.ctx, safe, string(data))
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.mods[safe]; ok {
		return old, nil
	}
	c.mods[safe] = mod
	return mod, nil
}

func compileFile(ctx context.Context, name, source string) (*moejs.Module, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return moejs.CompileWith(name, source, moejs.CompileOptions{TypeScript: isTS(name), Context: ctx})
}

func readToolDefs(rt *moejs.Runtime, mod *moejs.Module) ([]toolDef, bool, error) {
	for _, hookName := range []struct {
		export  string
		members []string
	}{
		{"tools", nil},
		{"default", []string{"tools"}},
	} {
		hook, err := mod.Hook(hookName.export, hookName.members...)
		if err != nil {
			continue
		}
		ok, err := rt.Has(hook)
		if err != nil {
			return nil, false, err
		}
		if !ok {
			continue
		}
		res, err := rt.Call(hook)
		if err != nil {
			return nil, true, err
		}
		val, err := rt.ToGo(res)
		if err != nil {
			return nil, true, err
		}
		defs, err := decodeDefs(val)
		return defs, true, err
	}
	if value, ok := rt.Export("tools"); ok {
		val, err := rt.ToGo(value)
		if err != nil {
			return nil, false, err
		}
		if _, isArray := val.([]any); isArray {
			defs, err := decodeDefs(val)
			return defs, true, err
		}
	}
	return nil, false, nil
}

func findCall(rt *moejs.Runtime, mod *moejs.Module) (moejs.Hook, bool, error) {
	return findHandler(rt, mod, "call")
}

func findHandler(rt *moejs.Runtime, mod *moejs.Module, name string) (moejs.Hook, bool, error) {
	for _, item := range []struct {
		export  string
		members []string
	}{
		{name, nil},
		{"default", []string{name}},
	} {
		hook, err := mod.Hook(item.export, item.members...)
		if err != nil {
			continue
		}
		ok, err := rt.Has(hook)
		if err != nil {
			return moejs.Hook{}, false, err
		}
		if ok {
			return hook, true, nil
		}
	}
	return moejs.Hook{}, false, nil
}

func exportHook(rt *moejs.Runtime, mod *moejs.Module, name string) (moejs.Hook, bool, error) {
	hook, err := mod.Hook(name)
	if err != nil {
		return moejs.Hook{}, false, nil
	}
	ok, err := rt.Has(hook)
	return hook, ok, err
}

func decodeDefs(v any) ([]toolDef, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var defs []toolDef
	if json.Unmarshal(raw, &defs) != nil {
		return nil, fmt.Errorf("tools 必须是工具定义数组")
	}
	seen := map[string]bool{}
	for _, def := range defs {
		if !validToolName(def.Name) {
			return nil, fmt.Errorf("工具名无效: %s", def.Name)
		}
		if seen[def.Name] {
			return nil, fmt.Errorf("工具名重复: %s", def.Name)
		}
		seen[def.Name] = true
	}
	if len(defs) == 0 {
		return nil, nil
	}
	return defs, nil
}

func validToolName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
		case i > 0 && r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}

func reserved(name string) bool {
	switch name {
	case "tools", "call", "meta", "default", "plugin", "onRequest":
		return true
	}
	for _, hook := range hookOrder {
		if name == hook {
			return true
		}
	}
	return false
}

func collectHooks(rt *moejs.Runtime, mod *moejs.Module) (map[string]moejs.Hook, error) {
	hooks := map[string]moejs.Hook{}
	for _, name := range hookOrder {
		hook, ok, err := exportHook(rt, mod, name)
		if err != nil {
			return nil, err
		}
		if !ok {
			nested, nestErr := mod.Hook("default", name)
			if nestErr != nil {
				continue
			}
			ok, err = rt.Has(nested)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			hook = nested
		}
		hooks[name] = hook
	}
	return hooks, nil
}

func (p *running) hookNames() []string {
	if p == nil || len(p.hooks) == 0 {
		return nil
	}
	names := make([]string, 0, len(p.hooks))
	for _, name := range hookOrder {
		if _, ok := p.hooks[name]; ok {
			names = append(names, name)
		}
	}
	return names
}

func bindTools(run *running, id, display string, defs []toolDef, explicit bool, callHook moejs.Hook, hasCall bool, mod *moejs.Module, rt *moejs.Runtime) error {
	if !explicit {
		for _, name := range mod.Exports() {
			if reserved(name) {
				continue
			}
			_, ok, err := exportHook(rt, mod, name)
			if err != nil {
				return err
			}
			if !ok {
				continue
			}
			defs = append(defs, toolDef{Name: name, Description: name})
		}
	}
	if len(defs) == 0 {
		return nil
	}
	seen := map[string]bool{}
	for _, def := range defs {
		hook := callHook
		viaCall := hasCall
		if !hasCall {
			found, ok, err := exportHook(rt, mod, def.Name)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("工具 %s 没有对应的导出函数，也没有 call", def.Name)
			}
			hook = found
		}
		public := id + "__" + ident(def.Name)
		if def.Expose != "" {
			if !validToolName(def.Expose) {
				return fmt.Errorf("工具公开名无效: %s", def.Expose)
			}
			public = def.Expose
		}
		if seen[public] {
			return fmt.Errorf("工具名重复: %s", public)
		}
		seen[public] = true
		desc := strings.TrimSpace(def.Description)
		if desc == "" {
			desc = def.Name
		}
		if display != "" && def.Expose == "" {
			desc = display + "：" + desc
		}
		if len([]rune(desc)) > 2000 {
			desc = string([]rune(desc)[:2000])
		}
		params := def.Parameters
		if string(params) == "null" || len(params) == 0 {
			params = nil
		}
		binding := toolBinding{short: def.Name, hook: hook, viaCall: viaCall}
		run.names = append(run.names, public)
		self := run
		run.bound = append(run.bound, BoundTool{
			Name: public, Description: desc, ReadOnly: def.ReadOnly, Chat: def.Chat, Parameters: append(json.RawMessage(nil), params...),
			Call: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				return self.invoke(ctx, binding, args)
			},
		})
	}
	return nil
}

func (p *running) invoke(ctx context.Context, b toolBinding, args map[string]any) (map[string]any, error) {
	if args == nil {
		args = map[string]any{}
	}
	var payload any = args
	if b.viaCall {
		payload = map[string]any{"name": b.short, "args": args}
	}
	out, err := p.eval(ctx, b.hook, payload)
	if err != nil {
		return nil, err
	}
	return asResult(out), nil
}

func (p *running) eval(ctx context.Context, hook moejs.Hook, payload any, discardOnCancel ...bool) (any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case p.gate <- struct{}{}:
		defer func() { <-p.gate }()
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %v", errPluginBusy, ctx.Err())
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errPluginBusy, err)
	}
	if p.closed {
		return nil, errors.New("插件已停用或重新加载，请重试")
	}
	if len(discardOnCancel) > 0 && discardOnCancel[0] {
		defer func() {
			if ctx.Err() != nil {
				p.closed = true
			}
		}()
	}
	defer p.rt.ReleaseCallData()
	var res moejs.Value
	err := p.run(ctx, func(rt *moejs.Runtime) error {
		arg, err := rt.FromGo(payload)
		if err != nil {
			return err
		}
		res, err = rt.Call(hook, arg)
		return err
	})
	if err != nil {
		return nil, jsError(err)
	}
	res, err = settledValue(p.rt, res)
	if err != nil {
		return nil, err
	}
	out, err := p.rt.ToGo(res)
	if err != nil {
		return nil, jsError(err)
	}
	return out, nil
}

func asResult(v any) map[string]any {
	switch value := v.(type) {
	case map[string]any:
		return value
	case nil:
		return map[string]any{}
	case string:
		return map[string]any{"text": value}
	case []any:
		return map[string]any{"items": value}
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return map[string]any{"value": fmt.Sprint(value)}
		}
		var obj map[string]any
		if json.Unmarshal(raw, &obj) == nil && obj != nil {
			return obj
		}
		return map[string]any{"value": json.RawMessage(raw)}
	}
}

func readMeta(rt *moejs.Runtime) (string, string, map[string]int) {
	value, ok := rt.Export("meta")
	if !ok {
		return "", "", nil
	}
	raw, err := rt.ToGo(value)
	if err != nil {
		return "", "", nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return "", "", nil
	}
	var meta struct {
		DisplayName  string                     `json:"displayName"`
		Name         string                     `json:"name"`
		Description  string                     `json:"description"`
		Remark       string                     `json:"remark"`
		HookPriority map[string]json.RawMessage `json:"hookPriority"`
	}
	if json.Unmarshal(encoded, &meta) != nil {
		return "", "", nil
	}
	display := meta.DisplayName
	if display == "" {
		display = meta.Name
	}
	description := meta.Description
	if description == "" {
		description = meta.Remark
	}
	priority := map[string]int{}
	for name, raw := range meta.HookPriority {
		var value int
		if json.Unmarshal(raw, &value) == nil {
			priority[name] = value
		}
	}
	return display, description, priority
}

func jsError(err error) error {
	if err == nil {
		return nil
	}
	var syntax *moejs.SyntaxError
	if errors.As(err, &syntax) {
		return syntax
	}
	var exc *moejs.Exception
	if errors.As(err, &exc) {
		return fmt.Errorf("%s: %s", exc.Name(), exc.Message())
	}
	if errors.Is(err, moejs.ErrMemoryLimit) {
		return errors.New("插件超出内存上限")
	}
	var interrupted *moejs.InterruptedError
	if errors.As(err, &interrupted) {
		if interrupted.Value != nil {
			return fmt.Errorf("插件执行超时或被中断: %v", interrupted.Value)
		}
		return errors.New("插件执行超时或被中断")
	}
	return err
}

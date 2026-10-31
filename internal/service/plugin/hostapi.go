//go:build !386 && !arm

package plugin

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/MoeForge/moejs"
	"github.com/MoeForge/moejs/eventloop"
	"github.com/MoeForge/moejs/node"
	"github.com/MoeForge/moejs/webapi"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// Backend services are named capabilities declared in package.json, not plugin-id exceptions.
func (p *running) setHostServices(services map[string]ServiceHandler, declared []string, dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	dataPath, err := jsPath(dataDir)
	if err != nil {
		return err
	}
	return p.rt.SetGlobal("loopra", map[string]any{"dataDir": dataPath, "services": map[string]any{"request": moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		name := moejs.Arg(args, 0).String()
		if !slices.Contains(declared, name) {
			return moejs.Undefined(), fmt.Errorf("插件未声明宿主服务: %s", name)
		}
		request := services[name]
		if request == nil {
			return moejs.Undefined(), fmt.Errorf("宿主未提供此服务: %s", name)
		}
		action := moejs.Arg(args, 1).String()
		value, err := p.rt.ToGo(moejs.Arg(args, 2))
		if err != nil {
			return moejs.Undefined(), err
		}
		input, _ := value.(map[string]any)
		out, err := request(p.callContext, action, input)
		if err != nil {
			return moejs.Undefined(), err
		}
		return p.rt.FromGo(out)
	})}})
}

func (p *running) hasRequest() bool { return p != nil && p.requestHook != nil }

func (p *running) request(ctx context.Context, input map[string]any) (any, error) {
	if !p.hasRequest() {
		return nil, errors.New("插件未提供 onRequest")
	}
	return p.eval(ctx, *p.requestHook, input, true)
}

func consoleObject(id string) map[string]any {
	out := map[string]any{}
	for _, level := range []string{"log", "info", "warn", "error", "debug"} {
		out[level] = moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
			parts := make([]string, 0, len(args))
			for _, arg := range args {
				parts = append(parts, arg.String())
			}
			message := strings.Join(parts, " ")
			if len(message) > 8192 {
				message = message[:8192] + "…"
			}
			switch level {
			case "warn":
				logging.Warnf("plugin", "%s: %s", id, message)
			case "error":
				logging.Errorf("plugin", "%s: %s", id, message)
			case "debug":
				logging.Debugf("plugin", "%s: %s", id, message)
			default:
				logging.Infof("plugin", "%s: %s", id, message)
			}
			return moejs.Undefined(), nil
		})
	}
	return out
}

// 和 moejs 指南里 Web API 示例用的客户端超时一致。一次工具或钩子调用最多等这么久。
const pluginCallTimeout = 10 * time.Minute

// 和 moejs 指南里安装 node:fs 的示例一致。超过这个大小的文件和响应体会被运行时拒绝。
const pluginMemoryLimit = 256 << 20

// newHostRuntime 按 moejs 指南安装事件循环、Web API 和 node:fs。
// fetch 的 Allow 为空，本进程能访问的地址都不拦截。
// 文件根是本机文件系统；Windows 上是系统盘，JavaScript 里看到的挂载点是 /。
// 可以写。不另加路径 Allow。
func newHostRuntime(cache *modCache) (*running, error) {
	root, mount, cwd, err := filesystemRoot()
	if err != nil {
		return nil, err
	}
	rt := moejs.NewRuntime(moejs.Options{
		MemoryLimit:        pluginMemoryLimit,
		DisableDynamicCode: true,
		Locale:             "zh-CN",
		Importer:           node.Importer(&moejs.Importer{Resolve: cache.resolve}),
	})
	loop, err := eventloop.New(rt, eventloop.Options{})
	if err != nil {
		return nil, err
	}
	fs, err := node.InstallLoop(loop, node.Options{
		FS: &node.FSOptions{
			Root:              root,
			Mount:             mount,
			Cwd:               cwd,
			Write:             true,
			NoDescriptorCache: true,
		},
		Buffer: true,
	})
	if err != nil {
		return nil, err
	}
	web, err := webapi.Install(loop, webapi.Options{
		Client: &http.Client{Timeout: pluginCallTimeout},
	})
	if err != nil {
		_ = fs.Close()
		return nil, err
	}
	return &running{rt: rt, loop: loop, node: fs, web: web, gate: make(chan struct{}, 1)}, nil
}

func (p *running) close() {
	if p == nil {
		return
	}
	p.closeOnce.Do(func() {
		p.gate <- struct{}{}
		defer func() { <-p.gate }()
		p.closed = true
		p.loop.Terminate()
		p.rt.ClearInterrupt()
		if p.web != nil {
			p.web.Close()
		}
		if p.node != nil {
			_ = p.node.Close()
		}
	})
}

// run 在事件循环上执行 fn，并等 fetch、定时器和 node:fs 的 Promise 结束。
func (p *running) run(ctx context.Context, fn func(*moejs.Runtime) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, pluginCallTimeout)
	defer cancel()
	p.callContext = ctx
	defer func() { p.callContext = nil }()
	if p.web != nil {
		p.web.SetContext(ctx)
	}
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		p.loop.Interrupt(context.Cause(ctx))
		close(interrupted)
	})
	defer func() {
		if !stop() {
			<-interrupted
		}
		p.rt.ClearInterrupt()
	}()
	return p.loop.Run(fn)
}

// filesystemRoot 是 node:fs 能看到的整棵目录。
// Unix 上根是 /。Windows 上 os.Root 只能覆盖一个盘，这里用系统盘，挂到 /。
func filesystemRoot() (root, mount, cwd string, err error) {
	mount = "/"
	if runtime.GOOS == "windows" {
		drive := os.Getenv("SystemDrive")
		if drive == "" {
			drive = "C:"
		}
		root = drive + `\`
	} else {
		root = "/"
	}
	wd, err := os.Getwd()
	if err != nil {
		return root, mount, mount, nil
	}
	rel, relErr := filepath.Rel(root, wd)
	if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return root, mount, mount, nil
	}
	if rel == "." {
		return root, mount, mount, nil
	}
	return root, mount, "/" + filepath.ToSlash(rel), nil
}

// jsPath 把宿主路径换成插件里 node:fs 看到的路径。
func jsPath(host string) (string, error) {
	abs, err := filepath.Abs(host)
	if err != nil {
		return "", err
	}
	root, mount, _, err := filesystemRoot()
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%s 不在 %s 上", abs, root)
	}
	if rel == "." {
		return mount, nil
	}
	if mount == "/" {
		return "/" + filepath.ToSlash(rel), nil
	}
	return mount + "/" + filepath.ToSlash(rel), nil
}

func settledValue(rt *moejs.Runtime, v moejs.Value) (moejs.Value, error) {
	for range 8 {
		state, result, ok := moejs.PromiseResult(v)
		if !ok {
			return v, nil
		}
		switch state {
		case moejs.PromiseFulfilled:
			v = result
		case moejs.PromiseRejected:
			return moejs.Undefined(), rejectionError(rt, result)
		default:
			return moejs.Undefined(), errors.New("插件返回了还没完成的 Promise")
		}
	}
	return moejs.Undefined(), errors.New("插件返回了还没完成的 Promise")
}

func rejectionError(rt *moejs.Runtime, v moejs.Value) error {
	if v.IsObject() {
		name, nameErr := rt.Get(v, "name")
		msg, msgErr := rt.Get(v, "message")
		if msgErr == nil && msg.IsString() && msg.String() != "" {
			label := "Error"
			if nameErr == nil && name.IsString() && name.String() != "" {
				label = name.String()
			}
			return fmt.Errorf("%s: %s", label, msg.String())
		}
	}
	if v.IsString() {
		return errors.New(v.String())
	}
	if v.IsUndefined() || v.IsNull() {
		return errors.New("插件的 Promise 被拒绝")
	}
	return errors.New(v.String())
}

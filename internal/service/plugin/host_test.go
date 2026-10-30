package plugin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestInstallRunsTypeScriptModule(t *testing.T) {
	home := t.TempDir()
	var bound []BoundTool
	h := New(home, Hooks{Bind: func(tools []BoundTool) { bound = append([]BoundTool(nil), tools...) }})
	h.Fetcher = npmTar(t, "demo-plugin", "1.2.3", map[string]string{
		"package/package.json": `{"name":"demo-plugin","version":"1.2.3","description":"demo","loopra":"./plugin.ts"}`,
		"package/plugin.ts":    "import { hi } from \"./lib.js\";\nexport const meta = { displayName: \"Demo\", description: \"says hello\" };\nexport function greet(args: { name?: string }) {\n  return { text: hi(args.name ?? \"world\") };\n}\n",
		"package/lib.ts":       "export function hi(name: string): string { return \"hello \" + name; }\n",
	})
	view, err := h.Install(context.Background(), "demo-plugin@1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if view.ID != "demo_plugin" || view.DisplayName != "Demo" || view.Version != "1.2.3" || !view.Enabled || view.State != "已启用" {
		t.Fatalf("view = %+v", view)
	}
	if len(bound) != 1 || bound[0].Name != "demo_plugin__greet" || !strings.Contains(bound[0].Description, "Demo") {
		t.Fatalf("tools = %+v", bound)
	}
	out, err := bound[0].Call(context.Background(), map[string]any{"name": "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	if out["text"] != "hello Ada" {
		t.Fatalf("result = %#v", out)
	}

	disabled, err := h.SetEnabled(context.Background(), view.ID, false)
	if err != nil || disabled.Enabled || len(h.Bound()) != 0 {
		t.Fatalf("disable = %+v %v bound=%d", disabled, err, len(h.Bound()))
	}
	enabled, err := h.SetEnabled(context.Background(), view.ID, true)
	if err != nil || !enabled.Enabled || len(h.Bound()) != 1 {
		t.Fatalf("enable = %+v %v", enabled, err)
	}
	if err := h.Remove(view.ID); err != nil {
		t.Fatal(err)
	}
	if len(h.List()) != 0 || len(h.Bound()) != 0 {
		t.Fatalf("after remove list=%d bound=%d", len(h.List()), len(h.Bound()))
	}
}

func TestInstallCallDispatcher(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	h.Fetcher = npmTar(t, "greeter", "1.0.0", map[string]string{
		"package/package.json": `{"name":"greeter","version":"1.0.0","loopra":"./plugin.js"}`,
		"package/plugin.js": `export function tools() {
  return [{ name: "greet", description: "say hi", readOnly: true, parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];
}
export function call(input) {
  return { text: "hello " + input.args.name };
}
`,
	})
	if _, err := h.Install(context.Background(), "greeter@1.0.0"); err != nil {
		t.Fatal(err)
	}
	tools := h.Bound()
	if len(tools) != 1 || tools[0].Name != "greeter__greet" || !tools[0].ReadOnly {
		t.Fatalf("tools = %+v", tools)
	}
	out, err := tools[0].Call(context.Background(), map[string]any{"name": "Lin"})
	if err != nil || out["text"] != "hello Lin" {
		t.Fatalf("call = %v %v", out, err)
	}
}

func TestInstallRejectsEscapeAndJar(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	if _, err := h.Install(context.Background(), "https://example.com/plugin.jar"); err == nil || !strings.Contains(err.Error(), "JAR") {
		t.Fatalf("jar error = %v", err)
	}
	h.Fetcher = npmTar(t, "escape-plugin", "1.0.0", map[string]string{
		"package/package.json": `{"name":"escape-plugin","version":"1.0.0","main":"plugin.js"}`,
		"package/plugin.js":    "import secret from \"../secret.js\";\nexport function greet() { return { text: secret }; }\n",
	})
	_, err := h.Install(context.Background(), "escape-plugin@1.0.0")
	if err == nil || !strings.Contains(err.Error(), "越出") {
		t.Fatalf("escape error = %v", err)
	}
	list := h.List()
	if len(list) != 1 || list[0].State != "加载失败" || list[0].Error == "" {
		t.Fatalf("broken plugin = %+v", list)
	}
}

func TestInstallGitHubArchive(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	archive := tarGz(map[string]string{
		"demo-main/plugin.js": "export function ping() { return { text: \"pong\" }; }\n",
	})
	h.Fetcher = func(ctx context.Context, rawURL string) ([]byte, error) {
		if strings.Contains(rawURL, "codeload.github.com/acme/demo/tar.gz/refs/heads/main") {
			return archive, nil
		}
		return nil, fmt.Errorf("unexpected %s", rawURL)
	}
	view, err := h.Install(context.Background(), "https://github.com/acme/demo")
	if err != nil {
		t.Fatal(err)
	}
	if view.ID != "demo" || len(h.Bound()) != 1 || h.Bound()[0].Name != "demo__ping" {
		t.Fatalf("view=%+v tools=%+v", view, h.Bound())
	}
	out, err := h.Bound()[0].Call(context.Background(), map[string]any{})
	if err != nil || out["text"] != "pong" {
		t.Fatalf("ping = %v %v", out, err)
	}
}

func npmTar(t *testing.T, name, version string, files map[string]string) func(context.Context, string) ([]byte, error) {
	t.Helper()
	archive := tarGz(files)
	meta := []byte(`{"version":"` + version + `","dist":{"tarball":"https://registry.npmjs.org/` + name + `/-/` + name + `-` + version + `.tgz"}}`)
	return func(ctx context.Context, rawURL string) ([]byte, error) {
		switch {
		case strings.Contains(rawURL, "/"+name+"/"+version):
			return meta, nil
		case strings.Contains(rawURL, name+"-"+version+".tgz"):
			return archive, nil
		default:
			return nil, fmt.Errorf("unexpected %s", rawURL)
		}
	}
}

func tarGz(files map[string]string) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range files {
		hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}
		if err := tw.WriteHeader(hdr); err != nil {
			panic(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			panic(err)
		}
	}
	if err := tw.Close(); err != nil {
		panic(err)
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

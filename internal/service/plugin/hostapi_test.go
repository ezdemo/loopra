package plugin

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginFetchAndFiles(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "note.txt")
	jsFile, err := jsPath(file)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "text/plain" {
			t.Errorf("content-type = %s", r.Header.Get("Content-Type"))
		}
		_, _ = io.WriteString(w, "echo:"+string(body))
	}))
	t.Cleanup(srv.Close)

	h := New(t.TempDir(), Hooks{})
	h.Fetcher = npmTar(t, "host-io", "1.0.0", map[string]string{
		"package/package.json": `{"name":"host-io","version":"1.0.0","loopra":"./plugin.js"}`,
		"package/plugin.js": `
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export function save(args) {
  writeFileSync(args.path, args.text);
  return { text: readFileSync(args.path, "utf8") };
}
export async function again(args) {
  return { text: await readFile(args.path, "utf8") };
}
export async function grab(args) {
  const res = await fetch(args.url, { method: "POST", headers: { "content-type": "text/plain" }, body: args.body });
  return { text: await res.text(), status: res.status, ok: res.ok };
}
export async function wait() {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { text: "waited" };
}
`,
	})
	if _, err := h.Install(context.Background(), "host-io@1.0.0"); err != nil {
		t.Fatal(err)
	}
	tools := map[string]BoundTool{}
	for _, tool := range h.Bound() {
		tools[tool.Name] = tool
	}
	saved, err := tools["host_io__save"].Call(context.Background(), map[string]any{"path": jsFile, "text": "hello file"})
	if err != nil {
		t.Fatal(err)
	}
	if saved["text"] != "hello file" {
		t.Fatalf("save = %#v", saved)
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "hello file" {
		t.Fatalf("disk = %q", onDisk)
	}
	again, err := tools["host_io__again"].Call(context.Background(), map[string]any{"path": jsFile})
	if err != nil || again["text"] != "hello file" {
		t.Fatalf("again = %#v %v", again, err)
	}
	grabbed, err := tools["host_io__grab"].Call(context.Background(), map[string]any{"url": srv.URL, "body": "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if grabbed["text"] != "echo:ping" || grabbed["ok"] != true || !statusIs(grabbed["status"], 200) {
		t.Fatalf("grab = %#v", grabbed)
	}
	waited, err := tools["host_io__wait"].Call(context.Background(), map[string]any{})
	if err != nil || waited["text"] != "waited" {
		t.Fatalf("wait = %#v %v", waited, err)
	}
}

func TestMissingNodeBuiltin(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	h.Fetcher = npmTar(t, "needs-path", "1.0.0", map[string]string{
		"package/package.json": `{"name":"needs-path","version":"1.0.0","main":"plugin.js"}`,
		"package/plugin.js":    "import path from \"node:path\";\nexport function ping() { return { text: path }; }\n",
	})
	_, err := h.Install(context.Background(), "needs-path@1.0.0")
	if err == nil || !strings.Contains(err.Error(), "node:path") {
		t.Fatalf("error = %v", err)
	}
}

func statusIs(v any, want int64) bool {
	switch n := v.(type) {
	case int64:
		return n == want
	case int:
		return int64(n) == want
	case float64:
		return n == float64(want)
	default:
		return false
	}
}

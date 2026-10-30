package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundledWebFetch(t *testing.T) {
	root := findBundledRoot()
	if root == "" {
		t.Fatal("没有找到 plugins/web")
	}
	var agents []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agents = append(agents, r.Header.Get("User-Agent"))
		if r.URL.Path == "/challenge" && r.Header.Get("User-Agent") != "opencode" {
			w.Header().Set("Cf-Mitigated", "challenge")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.URL.Path == "/fail" {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if r.URL.Path == "/image" {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{1, 2, 3})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><body><h1>Title</h1><p>Hello <a href="https://example.com/docs">docs</a></p><script>secret</script></body></html>`))
	}))
	t.Cleanup(server.Close)

	h := New(t.TempDir(), Hooks{})
	if _, err := h.Install(context.Background(), filepath.Join(root, "web")); err != nil {
		t.Fatal(err)
	}
	tool := findTool(t, h, "web")
	if !tool.ReadOnly || !tool.Chat {
		t.Fatal("web should be a read-only chat tool")
	}

	markdown := callWeb(t, tool, map[string]any{"action": "fetch", "url": server.URL + "/page", "format": "markdown"})
	if !strings.Contains(markdown, "# Title") || !strings.Contains(markdown, "[docs](https://example.com/docs)") || strings.Contains(markdown, "secret") {
		t.Fatalf("markdown = %s", markdown)
	}
	text := callWeb(t, tool, map[string]any{"action": "fetch", "url": server.URL + "/page", "format": "text"})
	if strings.Contains(text, "secret") || strings.Contains(text, "[docs]") || !strings.Contains(text, "Hello") {
		t.Fatalf("text = %s", text)
	}
	image := callWeb(t, tool, map[string]any{"action": "fetch", "url": server.URL + "/image"})
	if !strings.HasPrefix(image, "data:image/png;base64,") {
		t.Fatalf("image = %s", image)
	}
	if _, err := tool.Call(context.Background(), map[string]any{"action": "fetch", "url": "ftp://example.com"}); err == nil || !strings.Contains(err.Error(), "http://") {
		t.Fatalf("bad url error = %v", err)
	}
	if _, err := tool.Call(context.Background(), map[string]any{"action": "fetch", "url": server.URL + "/fail", "format": "html"}); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("status error = %v", err)
	}
	page := callWeb(t, tool, map[string]any{"action": "fetch", "url": server.URL + "/challenge", "format": "text"})
	if !strings.Contains(page, "Title") {
		t.Fatalf("challenge page = %s", page)
	}
	if len(agents) < 2 || agents[len(agents)-1] != "opencode" {
		t.Fatalf("user agents = %v", agents)
	}
	if _, err := tool.Call(context.Background(), map[string]any{"action": "browse"}); err == nil || !strings.Contains(err.Error(), "search") {
		t.Fatalf("action error = %v", err)
	}
	if _, err := tool.Call(context.Background(), map[string]any{"action": "search"}); err == nil || !strings.Contains(err.Error(), "query") {
		t.Fatalf("query error = %v", err)
	}
}

func findTool(t *testing.T, h *Host, name string) BoundTool {
	t.Helper()
	for _, tool := range h.Bound() {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("missing tool %s in %+v", name, h.Bound())
	return BoundTool{}
}

func callWeb(t *testing.T, tool BoundTool, args map[string]any) string {
	t.Helper()
	out, err := tool.Call(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	text, _ := out["result"].(string)
	if text == "" {
		t.Fatalf("result = %#v", out)
	}
	return text
}

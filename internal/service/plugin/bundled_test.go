package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/testutil"
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

func TestChatNekoAppendsOnlyInChat(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	if _, err := h.Install(context.Background(), testutil.ExternalPlugin(t, "chat-neko")); err != nil {
		t.Fatal(err)
	}
	if len(h.Bound()) != 0 {
		t.Fatalf("tools = %+v", h.Bound())
	}
	out, touched := h.RunHook(context.Background(), HookSystemPrompt, map[string]any{
		"app": "__loopra_chat__", "text": "base",
	}, nil)
	extra, _ := out["append"].(string)
	if !touched["append"] || !strings.Contains(extra, "猫娘") || !strings.Contains(extra, "称呼用户「你」") || touched["text"] {
		t.Fatalf("chat append = %q touched=%v", extra, touched)
	}
	if err := h.SetUIConfig("chat_neko", map[string]any{"nickname": "主人"}); err != nil {
		t.Fatal(err)
	}
	out, touched = h.RunHook(context.Background(), HookSystemPrompt, map[string]any{
		"app": "__loopra_chat__", "text": "base",
	}, nil)
	extra, _ = out["append"].(string)
	if !strings.Contains(extra, "称呼用户「主人」") {
		t.Fatalf("nickname append = %q", extra)
	}
	out, touched = h.RunHook(context.Background(), HookSystemPrompt, map[string]any{
		"app": "project", "text": "Working directory: C:\\code",
	}, nil)
	if touched["append"] || touched["text"] {
		t.Fatalf("project prompt changed: %v %v", out, touched)
	}
}

func TestChatNekoCoexistsWithOpenAPIAndContextLens(t *testing.T) {
	for _, order := range [][]string{{"chat-neko", "context-lens", "openapi"}, {"openapi", "context-lens", "chat-neko"}} {
		t.Run(strings.Join(order, "+"), func(t *testing.T) {
			h := New(t.TempDir(), Hooks{})
			for _, name := range order {
				if _, err := h.Install(context.Background(), testutil.ExternalPlugin(t, name)); err != nil {
					t.Fatal(err)
				}
			}
			if err := h.SetUIConfig("context_lens", map[string]any{"rules": []any{map[string]any{"key": `["__loopra_chat__","one"]`, "note": "PINNED"}}}); err != nil {
				t.Fatal(err)
			}
			out, _ := h.RunHook(context.Background(), HookSystemPrompt, map[string]any{"app": "__loopra_chat__", "text": "BASE"}, nil)
			text := out["text"].(string) + out["append"].(string)
			request, _ := h.RunHook(context.Background(), HookLLMRequest, map[string]any{"app": "__loopra_chat__", "sessionId": "one", "system": text}, nil)
			text, _ = request["system"].(string)
			for _, want := range []string{"BASE", "猫娘「小环」", "search_apis", "PINNED"} {
				if strings.Count(text, want) != 1 {
					t.Fatalf("combined system missing or duplicating %q: %q", want, text)
				}
			}
		})
	}
}

func TestDailyReviewDeclaresContributions(t *testing.T) {
	h := New(t.TempDir(), Hooks{})
	view, err := h.Install(context.Background(), testutil.ExternalPlugin(t, "daily-review"))
	if err != nil {
		t.Fatal(err)
	}
	if view.ID != "daily_review" || view.DisplayName != "每日回顾" || !view.Enabled || !view.Settings {
		t.Fatalf("view = %+v", view)
	}
	if view.Icon == nil || view.Icon.Name != "calendar" || view.Sidebar == nil || view.Sidebar.Title != "每日回顾" || view.Menu == nil || len(view.Menu.Children) != 2 {
		t.Fatalf("surfaces = %+v", view)
	}
	if view.Menu.Children[0].ID != "focus" || view.Menu.Children[1].ID != "about" {
		t.Fatalf("menu = %+v", view.Menu)
	}
	tool := findTool(t, h, "daily_review__checklist")
	if !tool.ReadOnly || tool.Chat {
		t.Fatalf("tool = %+v", tool)
	}
	out, err := tool.Call(context.Background(), map[string]any{"topic": "这次改动"})
	if err != nil {
		t.Fatal(err)
	}
	text, _ := out["text"].(string)
	if !strings.Contains(text, "发现 / 证据 / 下一步") {
		t.Fatalf("checklist = %q", text)
	}
	prompt, touched := h.RunHook(context.Background(), HookSystemPrompt, map[string]any{"text": "base"}, nil)
	if touched["append"] || touched["text"] {
		t.Fatalf("empty focus changed prompt: %v %v", prompt, touched)
	}
	if err := h.SetUIConfig("daily_review", map[string]any{"focus": "失败路径"}); err != nil {
		t.Fatal(err)
	}
	prompt, touched = h.RunHook(context.Background(), HookSystemPrompt, map[string]any{"text": "base"}, nil)
	extra, _ := prompt["append"].(string)
	if !touched["append"] || !strings.Contains(extra, "失败路径") || touched["text"] {
		t.Fatalf("focus append = %q touched=%v", extra, touched)
	}
	skills := h.Skills()
	if len(skills) != 1 || skills[0].PluginID != "daily_review" || skills[0].Name != "每日回顾" {
		t.Fatalf("skills = %+v", skills)
	}
	body, err := h.ReadSkill("daily_review", "SKILL.md")
	if err != nil || !strings.Contains(body, "发现 / 证据 / 下一步") {
		t.Fatalf("skill = %q %v", body, err)
	}
	agents := h.Subagents()
	if len(agents) != 1 || agents[0].ID != "plugin-daily_review" || !agents[0].ReadOnly || !strings.Contains(agents[0].Instructions, "@plugin-skills/daily_review") {
		t.Fatalf("agents = %+v", agents)
	}
	tasks := h.ScheduledTasks()
	if len(tasks) != 1 || tasks[0].ID != "plugin-daily_review" || tasks[0].CronExpr != "0 0 9 * * ?" || !tasks[0].Plugin {
		t.Fatalf("tasks = %+v", tasks)
	}
}

func TestBundledPluginsCanDisableButNotRemove(t *testing.T) {
	if findBundledRoot() == "" {
		t.Fatal("没有找到 plugins")
	}
	h := New(t.TempDir(), Hooks{})
	if err := h.upsert(record{ID: "retired", Name: "retired", DisplayName: "旧插件", Enabled: true, Builtin: true, Source: "old"}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	h.EnsureBundled(ctx)

	retired, ok := h.pluginRecord("retired")
	if !ok || retired.Builtin {
		t.Fatalf("retired = %+v ok=%v", retired, ok)
	}
	if err := h.Remove("retired"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"web"} {
		rec, ok := h.pluginRecord(id)
		if !ok || !rec.Builtin || !rec.Enabled {
			t.Fatalf("%s = %+v ok=%v", id, rec, ok)
		}
		if err := h.Remove(id); err == nil || err.Error() != "内置插件不能卸载" {
			t.Fatalf("remove %s: %v", id, err)
		}
	}
	for _, id := range []string{"chat_neko", "daily_review", "openapi", "context_lens"} {
		if h.Installed(id) {
			t.Fatalf("external plugin %s was still installed as a builtin", id)
		}
	}
	if _, err := h.SetEnabled(ctx, "web", false); err != nil {
		t.Fatal(err)
	}
	h.EnsureBundled(ctx)
	web, webOK := h.pluginRecord("web")
	if !webOK || web.Enabled || !web.Builtin {
		t.Fatalf("web=%+v", web)
	}
}

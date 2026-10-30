package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"iter"
	"strings"
	"sync"
	"testing"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/adk/model/provider"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/service/plugin"
)

func TestApplyCompactKeepsFragments(t *testing.T) {
	content := &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: "old"}}}
	if applyCompact(content, map[string]any{"summary": "new", "keep": []any{"frag", ""}}, map[string]bool{"summary": true, "keep": true}) {
		t.Fatal("rewrite was treated as a drop")
	}
	if plainText(content) != "new\nfrag" {
		t.Fatalf("summary = %q", plainText(content))
	}
	if !applyCompact(content, map[string]any{"drop": true}, map[string]bool{"drop": true}) {
		t.Fatal("drop was ignored")
	}
}

func TestPluginHooksRewriteTurn(t *testing.T) {
	host := plugin.New(t.TempDir(), plugin.Hooks{})
	installAgentPlugin(t, host, "hook-plugin", rewritePluginJS)
	t.Cleanup(func() { plugin.SetActive(nil) })
	plugin.SetActive(host)

	var saw probeArgs
	probe, err := functiontool.New[probeArgs, map[string]any](functiontool.Config{Name: "probe"}, func(_ adkagent.Context, args probeArgs) (map[string]any, error) {
		saw = args
		return map[string]any{"text": "ran"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	capture := &captureModel{inner: echo.New("fixture",
		echo.Script{ToolCalls: []*genai.FunctionCall{{Name: "probe", Args: map[string]any{}}}},
		echo.Script{Text: "done"},
	)}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{
		Model: capture, Tools: []tool.Tool{probe}, Instruction: "BASE",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithParentSession(context.Background(), "parent-1")
	created := createSession(t, a, "hooks")
	for _, err := range a.Run(ctx, created.Session, userText("hi")) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if !saw.Injected {
		t.Fatalf("tool args = %+v", saw)
	}
	if len(capture.temps) == 0 || capture.temps[0] != 0 {
		t.Fatalf("temperature = %#v", capture.temps)
	}
	if len(capture.bodies) == 0 || capture.bodies[0]["ping"] != true {
		t.Fatalf("wire body = %#v", capture.bodies)
	}
	stored := reloadSession(t, a, "hooks")
	transcript := sessionTranscript(stored)
	for _, want := range []string{"rewritten:hi", "extra", "after:ran", "from-plugin:done"} {
		if !strings.Contains(transcript, want) {
			t.Fatalf("transcript missing %q:\n%s", want, transcript)
		}
	}
	note := callPluginTool(t, host, "hook_plugin__note")
	for _, want := range []string{"BASE", "PLUGIN", provider.ProtocolChatCompletions, "completed", "parent-1"} {
		if !strings.Contains(note, want) {
			t.Fatalf("note %q missing %q", note, want)
		}
	}
}

func TestPluginHookCancelsTurn(t *testing.T) {
	host := plugin.New(t.TempDir(), plugin.Hooks{})
	installAgentPlugin(t, host, "hook-cancel", `
let seen = "";
export function turnBefore() { return { cancel: true, reason: "停" }; }
export function turnAfter(input) { seen = input.status || ""; return {}; }
export function note() { return { text: seen }; }
`)
	t.Cleanup(func() { plugin.SetActive(nil) })
	plugin.SetActive(host)
	model := &failModel{}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{Model: model})
	if err != nil {
		t.Fatal(err)
	}
	created := createSession(t, a, "cancel")
	var texts []string
	var runErr error
	for ev, err := range a.Run(context.Background(), created.Session, userText("hi")) {
		if err != nil {
			runErr = err
			continue
		}
		if ev == nil {
			continue
		}
		if text := plainText(ev.Content); text != "" {
			texts = append(texts, text)
		}
	}
	if runErr != nil || model.calls != 0 {
		t.Fatalf("calls=%d err=%v", model.calls, runErr)
	}
	if strings.Join(texts, "\n") != "停" {
		t.Fatalf("cancel text = %#v", texts)
	}
	if note := callPluginTool(t, host, "hook_cancel__note"); note != "cancelled" {
		t.Fatalf("status = %q", note)
	}
}

func TestPluginHookDeniesTool(t *testing.T) {
	host := plugin.New(t.TempDir(), plugin.Hooks{})
	installAgentPlugin(t, host, "hook-deny", `
export function toolBefore(input) {
  if (input.name === "blocked") return { decision: "deny", reason: "nope" };
  return { decision: "allow" };
}
`)
	t.Cleanup(func() { plugin.SetActive(nil) })
	plugin.SetActive(host)
	called := false
	blocked, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "blocked"}, func(adkagent.Context, struct{}) (map[string]any, error) {
		called = true
		return map[string]any{"text": "ran"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{
		Tools: []tool.Tool{blocked},
		Model: echo.New("fixture", echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "call-1", Name: "blocked"}}}, echo.Script{Text: "done"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	created := createSession(t, a, "deny")
	for _, err := range a.Run(context.Background(), created.Session, userText("go")) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if called {
		t.Fatal("denied tool ran")
	}
	if transcript := sessionTranscript(reloadSession(t, a, "deny")); !strings.Contains(transcript, "nope") {
		t.Fatalf("transcript = %s", transcript)
	}
}

func TestPluginHookAsksForTool(t *testing.T) {
	host := plugin.New(t.TempDir(), plugin.Hooks{})
	installAgentPlugin(t, host, "hook-ask", `
export function toolBefore(input) {
  if (input.name === "needs_ok") return { decision: "ask", reason: "please" };
  return { decision: "allow" };
}
`)
	t.Cleanup(func() { plugin.SetActive(nil) })
	plugin.SetActive(host)
	called := false
	needs, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "needs_ok"}, func(adkagent.Context, struct{}) (map[string]any, error) {
		called = true
		return map[string]any{"text": "ran"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{
		Tools: []tool.Tool{needs},
		Model: echo.New("fixture", echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "call-1", Name: "needs_ok", Args: map[string]any{}}}}),
	})
	if err != nil {
		t.Fatal(err)
	}
	created := createSession(t, a, "ask")
	confirms := 0
	var runErr error
	for ev, err := range a.Run(context.Background(), created.Session, userText("go")) {
		if err != nil {
			runErr = err
			continue
		}
		if ev != nil && len(ev.Actions.RequestedToolConfirmations) > 0 {
			confirms++
		}
	}
	transcript := sessionTranscript(reloadSession(t, a, "ask"))
	if called || confirms == 0 || !strings.Contains(transcript, "requires confirmation, please approve or reject") {
		t.Fatalf("called=%v confirms=%d err=%v transcript=%s", called, confirms, runErr, transcript)
	}
}

const rewritePluginJS = `
let seen = "";
export function turnBefore(input) {
  return { message: "rewritten:" + input.message, context: "extra" };
}
export function systemPrompt() { return { append: "\nPLUGIN" }; }
export function llmRequest(input) {
  seen = (input.system || "") + "|" + (input.protocol || "");
  return { temperature: 0, body: { ping: true } };
}
export function llmResponse(input) {
  if (input.toolCalls && input.toolCalls.length) return {};
  return { text: "from-plugin:" + (input.text || "") };
}
export function toolBefore(input) {
  var args = {};
  var src = input.args || {};
  for (var key in src) args[key] = src[key];
  args.injected = true;
  return { decision: "allow", args: args };
}
export function toolAfter(input) {
  var result = input.result || {};
  if (!result.text) return {};
  var next = {};
  for (var key in result) next[key] = result[key];
  next.text = "after:" + result.text;
  return { result: next };
}
export function turnAfter(input) {
  seen += "|" + (input.status || "") + "|" + (input.parentSessionId || "");
  return {};
}
export function note() { return { text: seen }; }
`

type probeArgs struct {
	Injected bool `json:"injected"`
}

type captureModel struct {
	inner  model.LLM
	mu     sync.Mutex
	temps  []float32
	bodies []map[string]any
}

func (m *captureModel) Name() string { return "capture" }

func (m *captureModel) Protocol() string { return provider.ProtocolChatCompletions }

func (m *captureModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	m.mu.Lock()
	if req != nil && req.Config != nil && req.Config.Temperature != nil {
		m.temps = append(m.temps, *req.Config.Temperature)
	}
	if body, ok := provider.TakeWireBody(req); ok {
		m.bodies = append(m.bodies, body)
	}
	m.mu.Unlock()
	return m.inner.GenerateContent(ctx, req, stream)
}

type failModel struct {
	calls int
}

func (m *failModel) Name() string { return "fail" }

func (m *failModel) GenerateContent(context.Context, *model.LLMRequest, bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.calls++
		yield(nil, fmt.Errorf("model should not run"))
	}
}

func installAgentPlugin(t *testing.T, h *plugin.Host, name, source string) {
	t.Helper()
	h.Fetcher = func(ctx context.Context, rawURL string) ([]byte, error) {
		switch {
		case strings.Contains(rawURL, "/"+name+"/1.0.0"):
			return []byte(`{"version":"1.0.0","dist":{"tarball":"https://registry.npmjs.org/` + name + `/-/` + name + `-1.0.0.tgz"}}`), nil
		case strings.Contains(rawURL, name+"-1.0.0.tgz"):
			return pluginArchive(name, source), nil
		default:
			return nil, fmt.Errorf("unexpected %s", rawURL)
		}
	}
	if _, err := h.Install(context.Background(), name+"@1.0.0"); err != nil {
		t.Fatal(err)
	}
}

func pluginArchive(name, source string) []byte {
	files := map[string]string{
		"package/package.json": `{"name":"` + name + `","version":"1.0.0","loopra":"./plugin.js"}`,
		"package/plugin.js":    source,
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for path, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: path, Mode: 0o644, Size: int64(len(body))}); err != nil {
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

func createSession(t *testing.T, a *Agent, id string) *session.CreateResponse {
	t.Helper()
	created, err := a.Sessions.Create(context.Background(), &session.CreateRequest{AppName: a.App(), UserID: a.User(), SessionID: id})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func reloadSession(t *testing.T, a *Agent, id string) session.Session {
	t.Helper()
	stored, err := a.Sessions.Get(context.Background(), &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: id})
	if err != nil {
		t.Fatal(err)
	}
	return stored.Session
}

func userText(text string) *genai.Content {
	return &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: text}}}
}

func sessionTranscript(sess session.Session) string {
	if sess == nil || sess.Events() == nil {
		return ""
	}
	var b strings.Builder
	events := sess.Events()
	for i := 0; i < events.Len(); i++ {
		ev := events.At(i)
		if ev == nil || ev.Content == nil {
			continue
		}
		b.WriteString(plainText(ev.Content))
		b.WriteByte('\n')
		for _, part := range ev.Content.Parts {
			if part == nil || part.FunctionResponse == nil || part.FunctionResponse.Response == nil {
				continue
			}
			b.WriteString(stringify(part.FunctionResponse.Response))
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func stringify(value map[string]any) string {
	return fmt.Sprint(value)
}

func callPluginTool(t *testing.T, h *plugin.Host, name string) string {
	t.Helper()
	for _, item := range h.Bound() {
		if item.Name != name {
			continue
		}
		out, err := item.Call(context.Background(), map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		text, _ := out["text"].(string)
		return text
	}
	t.Fatalf("missing tool %s", name)
	return ""
}

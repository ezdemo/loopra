package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/model/config"
	svcplugin "github.com/ezdemo/looprax/internal/service/plugin"
)

type longLoopModel struct {
	calls, summaries int
	requests         []*model.LLMRequest
	failSummary      bool
}

func (*longLoopModel) Name() string { return "long-loop" }
func (m *longLoopModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		if !stream {
			m.summaries++
			if m.failSummary {
				yield(nil, errors.New("summary unavailable"))
				return
			}
			yield(&model.LLMResponse{Content: genai.NewContentFromText("Checkpoint: continue CURRENT_GOAL.", genai.RoleModel), FinishReason: genai.FinishReasonStop}, nil)
			return
		}
		copy, _ := cloneRequest(req)
		m.requests = append(m.requests, copy)
		m.calls++
		parts := []*genai.Part{{Text: "finished"}}
		if m.calls < 8 {
			parts = []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: fmt.Sprintf("probe-%d", m.calls), Name: "probe", Args: map[string]any{}}}}
		}
		yield(&model.LLMResponse{
			Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
			UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: int32(contentChars(req.Contents) / 4)},
			FinishReason:  genai.FinishReasonStop,
		}, nil)
	}
}

func TestContextCompactsInsideToolLoopAndRestores(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint("failure=", fail), func(t *testing.T) {
			cfg := config.Default()
			cfg.MaxContextChars = 800
			cfg.ContextCompaction.RetainEvents = 2
			m := &longLoopModel{failSummary: fail}
			var executed atomic.Int32
			probe, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "probe"}, func(adkagent.Context, struct{}) (map[string]any, error) {
				executed.Add(1)
				return map[string]any{"result": strings.Repeat("tool evidence ", 35)}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			a, err := New(root, "project", &cfg, Options{Model: m, Tools: []tool.Tool{probe}})
			if err != nil {
				t.Fatal(err)
			}
			sess := createSession(t, a, "long").Session
			for _, err := range a.Run(t.Context(), sess, genai.NewContentFromText("CURRENT_GOAL: finish the requested change", genai.RoleUser)) {
				if err != nil {
					t.Fatal(err)
				}
			}
			if executed.Load() != 7 || m.calls != 8 || m.summaries == 0 {
				t.Fatalf("tools=%d calls=%d summaries=%d", executed.Load(), m.calls, m.summaries)
			}
			if fail && m.summaries != 1 {
				t.Fatalf("failed compaction repeated %d times within one invocation", m.summaries)
			}
			last, _ := json.Marshal(m.requests[len(m.requests)-1].Contents)
			if !strings.Contains(string(last), "CURRENT_GOAL:") {
				t.Fatal("the active user request was summarized away")
			}
			got, err := jsonl.NewService(root).Get(t.Context(), &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: "long"})
			if err != nil {
				t.Fatal(err)
			}
			summaries := 0
			for event := range got.Session.Events().All() {
				if event.Actions.Compaction != nil {
					summaries++
				}
			}
			if !fail && (summaries == 0 || !strings.Contains(string(last), "Checkpoint")) {
				t.Fatal("no durable checkpoint reached the next request")
			}
			if fail && summaries != 0 {
				t.Fatal("failed summary shadowed history")
			}
			before := m.calls
			a, err = New(root, "project", &cfg, Options{Model: echo.New("restart", echo.Script{Text: "continued"})})
			if err != nil {
				t.Fatal(err)
			}
			for _, err := range a.Run(t.Context(), got.Session, genai.NewContentFromText("continue", genai.RoleUser)) {
				if err != nil {
					t.Fatal(err)
				}
			}
			if m.calls != before || executed.Load() != 7 {
				t.Fatal("restarting replayed prior tools")
			}
		})
	}
}

func TestProjectionSurvivesRestartBudgetChangesAndKeepsOriginal(t *testing.T) {
	cfg := config.Default()
	cfg.ContextCompaction.ToolResultPrune = config.ToolResultPrune{ThresholdChars: 220, HeadChars: 60, TailChars: 20}
	root := t.TempDir()
	raw := jsonl.NewService(root)
	created, err := raw.Create(t.Context(), &session.CreateRequest{AppName: "p", UserID: "u", SessionID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	runtime, _ := NewContextRuntime(echo.New("test"), &cfg, "loopra")
	view := runtime.SessionService(raw, &cfg)
	got, err := view.Get(t.Context(), &session.GetRequest{AppName: "p", UserID: "u", SessionID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	original := strings.Repeat("evidence-世界", 100)
	event := &session.Event{
		ID: "parallel", Author: "loopra",
		Content: &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{
			{FunctionResponse: &genai.FunctionResponse{ID: "large", Name: "probe", Response: map[string]any{"result": original, "exitCode": 1, "error": "keep exact error"}}},
			{FunctionResponse: &genai.FunctionResponse{ID: "small", Name: "probe", Response: map[string]any{"result": strings.Repeat("s", 150)}}},
		}},
	}
	if err := view.AppendEvent(t.Context(), got.Session, event); err != nil {
		t.Fatal(err)
	}
	projected := got.Session.Events().At(0).Content
	if projected.Parts[0].FunctionResponse.Response["result"] == original ||
		projected.Parts[0].FunctionResponse.Response["error"] != "keep exact error" ||
		event.Content.Parts[0].FunctionResponse.Response["result"] != original {
		t.Fatal("projection changed the raw result or lost error metadata")
	}
	expected, _ := json.Marshal(projected)
	cfg.ContextCompaction.ToolResultPrune = config.ToolResultPrune{ThresholdChars: 110, HeadChars: 5, TailChars: 3}
	runtime, _ = NewContextRuntime(echo.New("test"), &cfg, "loopra")
	restarted := jsonl.NewService(root)
	view = runtime.SessionService(restarted, &cfg)
	got, err = view.Get(t.Context(), &session.GetRequest{AppName: "p", UserID: "u", SessionID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Session.Events().Len() != 1 {
		t.Fatalf("parallel results replayed %d events", got.Session.Events().Len())
	}
	actual, _ := json.Marshal(got.Session.Events().At(0).Content)
	if string(actual) != string(expected) {
		t.Fatal("restart or a new budget rewrote a stable projection")
	}
	full, err := restarted.Get(t.Context(), &session.GetRequest{AppName: "p", UserID: "u", SessionID: "s"})
	if err != nil || full.Session.Events().At(0).Content.Parts[0].FunctionResponse.Response["result"] != original {
		t.Fatal("raw session lost the full result")
	}
	audit, _ := os.ReadFile(filepath.Join(root, "workspace", "p", "sessions", "s.events"))
	if !strings.Contains(string(audit), original) || created.Session.ID() != "s" {
		t.Fatal("audit log lost the original")
	}
}

func TestCompactionUsesSelectedCapacityAndCanBeDisabled(t *testing.T) {
	cfg := config.Default()
	cfg.ModelChannels[0].Models = []config.ModelEntry{{Name: "selected", ContextTokens: 10000, MaxTokens: 3000}}
	cfg.ContextCompaction.RetainEvents = 5
	r, err := NewContextRuntime(echo.New("selected"), &cfg, "loopra")
	if err != nil || r.Compaction().TokenThreshold != 7000 || r.Compaction().EventRetentionSize != 5 {
		t.Fatalf("policy=%+v err=%v", r.Compaction(), err)
	}
	no := false
	cfg.ContextCompaction.Enabled = &no
	r, err = NewContextRuntime(echo.New("selected"), &cfg, "loopra")
	if err != nil || r.Compaction() != nil {
		t.Fatal("explicit disable was ignored")
	}
}

func TestSummaryHonorsCompactPluginAndCancellation(t *testing.T) {
	host := svcplugin.New(t.TempDir(), svcplugin.Hooks{})
	installAgentPlugin(t, host, "compact-test", `export function compact() { return { summary: "redacted checkpoint", keep: ["exact fact"] }; }`)
	svcplugin.SetActive(host)
	t.Cleanup(func() { svcplugin.SetActive(nil) })
	cfg := config.Default()
	r, _ := NewContextRuntime(echo.New("summary", echo.Script{Text: "checkpoint"}), &cfg, "loopra")
	events := []*session.Event{{Content: genai.NewContentFromText(strings.Repeat("context ", 50), genai.RoleUser)}}
	res, err := r.SummarizeEvents(t.Context(), events)
	if err != nil || plainText(res.Content) != "redacted checkpoint\nexact fact" {
		t.Fatalf("summary=%v err=%v", res.Content, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = r.SummarizeEvents(ctx, events)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation was ignored: %v", err)
	}
}

func TestPruningPreservesNonTextFieldsAndUnicode(t *testing.T) {
	in := map[string]any{"result": strings.Repeat("世界🙂", 500), "error": "exact", "exitCode": 17, "artifact": map[string]any{"id": "original"}}
	before, _ := json.Marshal(in)
	out, changed := pruneResponse(in, config.ToolResultPrune{ThresholdChars: 200, HeadChars: 50, TailChars: 10}, "call")
	after, _ := json.Marshal(in)
	if !changed || string(before) != string(after) || len([]rune(out["result"].(string))) > 200 ||
		out["error"] != in["error"] || !reflect.DeepEqual(out["artifact"], in["artifact"]) {
		t.Fatalf("bad prune: %v", out)
	}
}

func TestOriginalToolResultCanBeReadAfterCompactionAndRestart(t *testing.T) {
	cfg := config.Default()
	cfg.ContextCompaction.ToolResultPrune = config.ToolResultPrune{ThresholdChars: 220, HeadChars: 60, TailChars: 20}
	original := strings.Repeat("raw evidence ", 100) + "EXACT_TAIL"
	probe, _ := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "probe"}, func(adkagent.Context, struct{}) (map[string]any, error) {
		return map[string]any{"result": original}, nil
	})
	root := t.TempDir()
	a, err := New(root, "project", &cfg, Options{Model: echo.New("fixture",
		echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "evidence", Name: "probe"}}},
		echo.Script{Text: "first turn done"},
	), Tools: []tool.Tool{probe}})
	if err != nil {
		t.Fatal(err)
	}
	sess := createSession(t, a, "read").Session
	for _, err := range a.Run(t.Context(), sess, genai.NewContentFromText("collect", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
	}
	prior, err := a.Sessions.Get(t.Context(), &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: sess.ID()})
	if err != nil {
		t.Fatal(err)
	}
	events := prior.Session.Events()
	if err := a.Sessions.AppendEvent(t.Context(), prior.Session, &session.Event{
		Author: "model", Timestamp: time.Now(),
		Actions: session.EventActions{Compaction: &session.EventCompaction{
			StartTimestamp:   events.At(0).Timestamp,
			EndTimestamp:     events.At(events.Len() - 1).Timestamp,
			CompactedContent: genai.NewContentFromText("Earlier evidence was collected.", genai.RoleModel),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	a, err = New(root, "project", &cfg, Options{Model: echo.New("fixture",
		echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "retrieve", Name: "read_tool_result", Args: map[string]any{"callId": "evidence", "offset": len(original) - 50, "limit": 100}}}},
		echo.Script{Text: "done"},
	)})
	if err != nil {
		t.Fatal(err)
	}
	sess, err = a.Session(t.Context(), "read")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for event, err := range a.Run(t.Context(), sess, genai.NewContentFromText("read the retained evidence", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if fr := part.FunctionResponse; fr != nil && fr.Name == "read_tool_result" {
				found = strings.Contains(fmt.Sprint(fr.Response["text"]), "EXACT_TAIL")
				if !found {
					t.Fatalf("full result could not be retrieved: %v", fr.Response)
				}
			}
		}
	}
	if !found {
		t.Fatal("retrieval tool did not execute")
	}
}

type snapshotInvocation struct {
	adkagent.StrictContextMock
	sess              session.Session
	root              adkagent.Agent
	branch, isolation string
}

func (c *snapshotInvocation) Session() session.Session { return c.sess }
func (c *snapshotInvocation) Agent() adkagent.Agent    { return c.root }
func (c *snapshotInvocation) Branch() string           { return c.branch }
func (c *snapshotInvocation) IsolationScope() string   { return c.isolation }
func (*snapshotInvocation) InvocationID() string       { return "snapshot-turn" }

func TestSummaryReplaysWarmWirePrefixAndRefusesOtherScopes(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		json.NewDecoder(req.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"short checkpoint"},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":180}}}`)
	}))
	defer server.Close()
	cfg := config.Default()
	cfg.ModelChannels[0].BaseURL = server.URL
	cfg.ModelChannels[0].APIKey = "test-only"
	a, err := New(t.TempDir(), "project", &cfg, Options{})
	if err != nil {
		t.Fatal(err)
	}
	sess := createSession(t, a, "snapshots").Session
	runtime, err := NewContextRuntime(a.Model, &cfg, "loopra")
	if err != nil {
		t.Fatal(err)
	}
	invocation := &snapshotInvocation{
		StrictContextMock: adkagent.NewStrictContextMock(t.Context()),
		sess:              sess, root: a.Root, branch: "worker", isolation: "task-one",
	}
	ctx := adkagent.NewContext(invocation)
	history := []*genai.Content{
		genai.NewContentFromText(strings.Repeat("exact earlier context ", 50), genai.RoleUser),
		genai.NewContentFromText("earlier answer", genai.RoleModel),
		genai.NewContentFromText("retained tail", genai.RoleUser),
	}
	req := &model.LLMRequest{
		Model: a.Model.Name(), Contents: history,
		Config: &genai.GenerateContentConfig{
			SystemInstruction: genai.NewContentFromText("original policy", genai.RoleUser),
			Tools:             []*genai.Tool{{FunctionDeclarations: []*genai.FunctionDeclaration{{Name: "probe", ParametersJsonSchema: map[string]any{"type": "object"}}}}},
		},
	}
	for _, err := range runtime.Model().GenerateContent(ctx, req, false) {
		if err != nil {
			t.Fatal(err)
		}
	}
	events := []*session.Event{
		{Content: history[0], Branch: invocation.branch, IsolationScope: invocation.isolation},
		{Content: history[1], Branch: invocation.branch, IsolationScope: invocation.isolation},
	}
	res, err := runtime.SummarizeEvents(ctx, events)
	if err != nil || plainText(res.Content) != "short checkpoint" || len(bodies) != 2 {
		t.Fatalf("summary=%v err=%v calls=%d", res.Content, err, len(bodies))
	}
	first, second := bodies[0]["messages"].([]any), bodies[1]["messages"].([]any)
	if !reflect.DeepEqual(first[:2], second[:2]) || !reflect.DeepEqual(bodies[0]["tools"], bodies[1]["tools"]) {
		t.Fatal("summary request changed the warmed history or tool declarations")
	}
	if !strings.Contains(fmt.Sprint(second[len(second)-1]), summaryInstruction) {
		t.Fatal("summary directive was not appended at the end")
	}
	sibling := *invocation
	sibling.isolation = "task-two"
	events[0].IsolationScope, events[1].IsolationScope = sibling.isolation, sibling.isolation
	if request, _ := runtime.prefixRequest(adkagent.NewContext(&sibling), events); request != nil {
		t.Fatal("another isolation scope borrowed a warm snapshot")
	}
	runtime.mu.Lock()
	size := len(runtime.snapshots)
	runtime.mu.Unlock()
	if size != 1 {
		t.Fatalf("snapshot scope count=%d", size)
	}
}

func TestOriginalResultReaderRefusesSiblingIsolation(t *testing.T) {
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{Model: echo.New("fixture",
		echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "retrieve", Name: "read_tool_result", Args: map[string]any{"callId": "private"}}}},
		echo.Script{Text: "done"},
	)})
	if err != nil {
		t.Fatal(err)
	}
	sess := createSession(t, a, "scope").Session
	if err := a.Sessions.AppendEvent(t.Context(), sess, &session.Event{
		ID: "private-event", Author: "worker", IsolationScope: "other-task",
		Content: &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "private", Name: "probe", Response: map[string]any{"result": "SECRET_EVIDENCE"}}}}},
	}); err != nil {
		t.Fatal(err)
	}
	seen := false
	for event, err := range a.Run(t.Context(), sess, genai.NewContentFromText("retrieve", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if fr := part.FunctionResponse; fr != nil && fr.Name == "read_tool_result" {
				seen = true
				if strings.Contains(fmt.Sprint(fr.Response), "SECRET_EVIDENCE") || fr.Response["error"] == nil {
					t.Fatalf("reader escaped its isolation scope: %v", fr.Response)
				}
			}
		}
	}
	if !seen {
		t.Fatal("reader did not report its refusal")
	}
}

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	svcplugin "github.com/ezdemo/looprax/internal/service/plugin"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type asyncModel struct {
	step    int
	respond func(context.Context, *model.LLMRequest, int) *genai.Content
}

func TestAsyncApprovalDoesNotStartExecutionAndPreservesPendingWork(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	release := make(chan struct{})
	var ran, dangerRan atomic.Int32
	slow, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "slow"}, func(ctx adkagent.Context, _ struct{}) (map[string]any, error) {
		ran.Add(1)
		select {
		case <-release:
			return map[string]any{"result": "background survived approval"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	danger, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "danger"}, func(adkagent.Context, struct{}) (map[string]any, error) {
		dangerRan.Add(1)
		close(release)
		return map[string]any{"result": "approved"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{
		Tools: []tool.Tool{tools.WithAsyncExecution(slow), tools.GateOne(tools.WithAsyncExecution(danger), func(string, any) bool { return true })},
		Model: echo.New("approval", echo.Script{ToolCalls: []*genai.FunctionCall{
			{ID: "slow-call", Name: "slow", Args: map[string]any{"yield_after_ms": 1}}, {ID: "danger-call", Name: "danger"},
		}}, echo.Script{Text: "done"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := a.Session(ctx, "approval")
	if err != nil {
		t.Fatal(err)
	}
	ctx, finish := a.ToolTurn(ctx, sess)
	defer func() {
		if err := finish(); err != nil {
			t.Error(err)
		}
	}()
	confirmID := ""
	for ev, err := range a.Run(ctx, sess, genai.NewContentFromText("run", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
		if ev.Content != nil {
			for _, p := range ev.Content.Parts {
				if p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName {
					confirmID = p.FunctionCall.ID
				}
			}
		}
	}
	if confirmID == "" || dangerRan.Load() != 0 || ran.Load() != 1 || !tools.AsyncFromContext(ctx).Pending() {
		t.Fatalf("confirmation=%s ran=%d danger=%d", confirmID, ran.Load(), dangerRan.Load())
	}
	msg := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{Name: toolconfirmation.FunctionCallName, ID: confirmID, Response: map[string]any{"confirmed": true}}}}}
	for _, err := range a.Run(ctx, sess, msg) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if ran.Load() != 1 || dangerRan.Load() != 1 || tools.AsyncFromContext(ctx).Pending() {
		t.Fatalf("ran=%d danger=%d pending=%v", ran.Load(), dangerRan.Load(), tools.AsyncFromContext(ctx).Pending())
	}
}

func TestAsyncAfterHookRunsOnlyOnFinalResult(t *testing.T) {
	host := svcplugin.New(t.TempDir(), svcplugin.Hooks{})
	installAgentPlugin(t, host, "async-hook", `
let count = 0;
export function toolAfter(input) {
  if (input.name !== "slow") return {};
  count++;
  return {result:{result:"rewritten-final", count:count}};
}
export function note() { return {text:String(count)}; }
`)
	svcplugin.SetActive(host)
	t.Cleanup(func() { svcplugin.SetActive(nil) })
	release := make(chan struct{})
	slow, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "slow"}, func(ctx adkagent.Context, _ struct{}) (map[string]any, error) {
		select {
		case <-release:
			return map[string]any{"result": "raw-final"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	m := &asyncModel{respond: func(ctx context.Context, req *model.LLMRequest, step int) *genai.Content {
		if step == 1 {
			return asyncCall("slow-call", "slow", map[string]any{"yield_after_ms": 1})
		}
		if step == 2 {
			if note := callPluginTool(t, host, "async_hook__note"); note != "0" {
				t.Fatalf("placeholder ran hook: %s", note)
			}
			close(release)
			return genai.NewContentFromText("waiting", genai.RoleModel)
		}
		raw, err := json.Marshal(req.Contents)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), "rewritten-final") || strings.Contains(string(raw), "raw-final") {
			t.Fatalf("hook not applied: %s", raw)
		}
		return genai.NewContentFromText("done", genai.RoleModel)
	}}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{Model: m, Tools: []tool.Tool{tools.WithAsyncExecution(slow)}})
	if err != nil {
		t.Fatal(err)
	}
	sess := createSession(t, a, "hook").Session
	for _, err := range a.Run(t.Context(), sess, userText("run")) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if note := callPluginTool(t, host, "async_hook__note"); note != "1" {
		t.Fatalf("hook count=%s", note)
	}
}

func (*asyncModel) Name() string { return "async-fixture" }
func (m *asyncModel) GenerateContent(ctx context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.step++
		yield(&model.LLMResponse{Content: m.respond(ctx, req, m.step), TurnComplete: true, FinishReason: genai.FinishReasonStop}, nil)
	}
}

func asyncCall(id, name string, args map[string]any) *genai.Content {
	return &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: id, Name: name, Args: args}}}}
}

func TestAsyncLoopDeliveryAndHistory(t *testing.T) {
	for _, mode := range []string{"idle", "next-step", "poll-running", "query-final", "failed"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			release := make(chan struct{})
			var executions atomic.Int32
			probe, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "slow"}, func(ctx adkagent.Context, _ struct{}) (map[string]any, error) {
				executions.Add(1)
				select {
				case <-release:
					if mode == "failed" {
						return nil, fmt.Errorf("fixture failure")
					}
					return map[string]any{"result": "unique-final-evidence"}, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			m := &asyncModel{}
			m.respond = func(ctx context.Context, req *model.LLMRequest, step int) *genai.Content {
				if step == 1 {
					return asyncCall("slow-call", "slow", map[string]any{"yield_after_ms": 1})
				}
				if step == 2 {
					if mode == "poll-running" {
						return asyncCall("poll", "tool_result", map[string]any{"call_id": "slow-call", "timeout_ms": 1})
					}
					close(release)
					if mode == "next-step" {
						if err := tools.AsyncFromContext(ctx).Wait(ctx); err != nil {
							t.Fatal(err)
						}
						return asyncCall("independent-1", "independent", map[string]any{})
					}
					if mode == "query-final" {
						if err := tools.AsyncFromContext(ctx).Wait(ctx); err != nil {
							t.Fatal(err)
						}
						return asyncCall("poll", "tool_result", map[string]any{"call_id": "slow-call", "timeout_ms": 100})
					}
					return genai.NewContentFromText("Waiting for the pending execution.", genai.RoleModel)
				}
				if mode == "poll-running" && step == 3 {
					close(release)
					return genai.NewContentFromText("Waiting for the pending execution.", genai.RoleModel)
				}
				raw, err := json.Marshal(req.Contents)
				if err != nil {
					t.Fatal(err)
				}
				evidence := "unique-final-evidence"
				if mode == "failed" {
					evidence = "fixture failure"
				}
				if strings.Count(string(raw), evidence) != 1 {
					t.Fatalf("final evidence missing or repeated: %s", raw)
				}
				if mode == "query-final" && strings.Contains(string(raw), "Tool completion notification") {
					t.Fatalf("query result also automatically injected: %s", raw)
				}
				if mode == "next-step" && step == 3 {
					return asyncCall("independent-2", "independent", map[string]any{})
				}
				return genai.NewContentFromText("done", genai.RoleModel)
			}
			cfg := config.Default()
			independent, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "independent"}, func(adkagent.Context, struct{}) (map[string]any, error) {
				return map[string]any{"result": "independent work"}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			a, err := New(t.TempDir(), "project", &cfg, Options{Model: m, Tools: []tool.Tool{tools.WithAsyncExecution(probe), independent}})
			if err != nil {
				t.Fatal(err)
			}
			sess, err := a.Session(ctx, "async")
			if err != nil {
				t.Fatal(err)
			}
			finals := 0
			for ev, err := range a.Run(ctx, sess, genai.NewContentFromText("run", genai.RoleUser)) {
				if err != nil {
					t.Fatal(err)
				}
				if ev.IsFinalResponse() && ev.CustomMetadata["asyncContinuation"] != true {
					finals++
				}
			}
			if executions.Load() != 1 || finals != 1 {
				t.Fatalf("executions=%d finals=%d", executions.Load(), finals)
			}
			restored, err := a.Sessions.Get(ctx, &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: sess.ID()})
			if err != nil {
				t.Fatal(err)
			}
			responses, completions := 0, 0
			for ev := range restored.Session.Events().All() {
				if ev.CustomMetadata["asyncToolResult"] != nil {
					completions++
				}
				if ev.Content != nil {
					for _, p := range ev.Content.Parts {
						if p.FunctionResponse != nil && p.FunctionResponse.ID == "slow-call" {
							responses++
						}
					}
				}
			}
			if responses != 1 || completions != 1 {
				t.Fatalf("history responses=%d completions=%d", responses, completions)
			}
			m.step = 0
			m.respond = func(_ context.Context, req *model.LLMRequest, step int) *genai.Content {
				if step == 1 {
					return asyncCall("retained", "read_tool_result", map[string]any{"callId": "slow-call"})
				}
				found := false
				for _, content := range req.Contents {
					for _, p := range content.Parts {
						if p.FunctionResponse == nil || p.FunctionResponse.ID != "retained" {
							continue
						}
						text, _ := p.FunctionResponse.Response["text"].(string)
						evidence := "unique-final-evidence"
						if mode == "failed" {
							evidence = "fixture failure"
						}
						found = strings.Contains(text, evidence)
					}
				}
				if !found {
					raw, _ := json.Marshal(req.Contents)
					t.Fatalf("retained result reader did not return final result: %s", raw)
				}
				return genai.NewContentFromText("read", genai.RoleModel)
			}
			for _, err := range a.Run(ctx, restored.Session, genai.NewContentFromText("inspect retained result", genai.RoleUser)) {
				if err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestAsyncLoopConsumerStopCancelsAndRecords(t *testing.T) {
	exited := make(chan struct{})
	probe, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "slow"}, func(ctx adkagent.Context, _ struct{}) (map[string]any, error) {
		defer close(exited)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	m := &asyncModel{respond: func(context.Context, *model.LLMRequest, int) *genai.Content {
		return asyncCall("slow-call", "slow", map[string]any{"yield_after_ms": 1})
	}}
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{Model: m, Tools: []tool.Tool{tools.WithAsyncExecution(probe)}})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := a.Session(t.Context(), "cancel")
	if err != nil {
		t.Fatal(err)
	}
	for ev, err := range a.Run(t.Context(), sess, genai.NewContentFromText("run", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
		if ev.Content != nil && len(ev.Content.Parts) > 0 && ev.Content.Parts[0].FunctionResponse != nil {
			break
		}
	}
	select {
	case <-exited:
	default:
		t.Fatal("iterator exited before the worker")
	}
	restored, err := a.Sessions.Get(t.Context(), &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: sess.ID()})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for ev := range restored.Session.Events().All() {
		if result, ok := ev.CustomMetadata["asyncToolResult"].(map[string]any); ok {
			found = result["status"] == "failed"
		}
	}
	if !found {
		t.Fatal("cancelled result not retained")
	}
}

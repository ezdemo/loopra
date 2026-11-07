package tools

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"
)

type asyncTestContext struct {
	agent.Context
	base context.Context
	id   string
}

func (c asyncTestContext) Value(k any) any                                    { return c.base.Value(k) }
func (c asyncTestContext) Done() <-chan struct{}                              { return c.base.Done() }
func (c asyncTestContext) Err() error                                         { return c.base.Err() }
func (c asyncTestContext) Deadline() (time.Time, bool)                        { return c.base.Deadline() }
func (c asyncTestContext) FunctionCallID() string                             { return c.id }
func (c asyncTestContext) InvocationID() string                               { return "test-turn" }
func (c asyncTestContext) WithAgentContext(ctx context.Context) agent.Context { c.base = ctx; return c }

type asyncFixture struct {
	run func(agent.Context) (map[string]any, error)
}

func (c asyncTestContext) ToolConfirmation() *toolconfirmation.ToolConfirmation { return nil }

func (asyncFixture) Name() string        { return "slow" }
func (asyncFixture) Description() string { return "fixture" }
func (asyncFixture) IsLongRunning() bool { return false }
func (asyncFixture) Declaration() *genai.FunctionDeclaration {
	return &genai.FunctionDeclaration{Name: "slow"}
}
func (f asyncFixture) Run(ctx agent.Context, _ any) (map[string]any, error) { return f.run(ctx) }

func startAsyncFixture(t *testing.T, run func(agent.Context) (map[string]any, error)) (*AsyncRuntime, context.Context) {
	t.Helper()
	ctx, runtime := NewAsyncRuntime(t.Context())
	runtime.yieldAfter = time.Millisecond
	t.Cleanup(runtime.Close)
	wrapped := WithAsyncExecution(asyncFixture{run: run}).(asyncRunnable)
	result, err := wrapped.Run(asyncTestContext{base: ctx, id: "call"}, map[string]any{})
	if err != nil || !IsAsyncPlaceholder("call", result) {
		t.Fatalf("yield = %v, %v", result, err)
	}
	return runtime, ctx
}

func TestAsyncPollRunningPreservesAutomaticDelivery(t *testing.T) {
	release := make(chan struct{})
	r, ctx := startAsyncFixture(t, func(ctx agent.Context) (map[string]any, error) {
		select {
		case <-release:
			return map[string]any{"result": "finished"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	result, err := r.Result(ctx, "call", 1)
	if err != nil || !IsAsyncPending(result) || !r.Pending() {
		t.Fatalf("poll = %v, %v", result, err)
	}
	close(release)
	if err := r.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	injected := 0
	if err := r.Drain(func(result AsyncResult, inject bool) error {
		if inject {
			injected++
		}
		if result.Response["result"] != "finished" {
			t.Fatalf("result = %v", result.Response)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if r.Pending() || injected != 1 {
		t.Fatalf("pending=%v injected=%d", r.Pending(), injected)
	}
	if err := r.Drain(func(AsyncResult, bool) error { t.Fatal("duplicate delivery"); return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestAsyncQueryAndInjectionHaveOneWinner(t *testing.T) {
	for i := 0; i < 50; i++ {
		release := make(chan struct{})
		r, ctx := startAsyncFixture(t, func(ctx agent.Context) (map[string]any, error) {
			select {
			case <-release:
				return map[string]any{"result": "finished"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
		close(release)
		if err := r.Wait(ctx); err != nil {
			t.Fatal(err)
		}
		var delivered atomic.Int32
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			result, err := r.Result(ctx, "call", 100)
			if err != nil {
				t.Error(err)
			}
			if result["status"] == "completed" {
				delivered.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if err := r.Drain(func(_ AsyncResult, inject bool) error {
				if inject {
					delivered.Add(1)
				}
				return nil
			}); err != nil {
				t.Error(err)
			}
		}()
		wg.Wait()
		if delivered.Load() != 1 {
			t.Fatalf("delivered %d times", delivered.Load())
		}
	}
}

func TestAsyncPersistenceFailureDoesNotConsumeResult(t *testing.T) {
	release := make(chan struct{})
	r, ctx := startAsyncFixture(t, func(ctx agent.Context) (map[string]any, error) {
		select {
		case <-release:
			return nil, errors.New("execution failed")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	close(release)
	if err := r.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("disk full")
	if err := r.Drain(func(AsyncResult, bool) error { return failure }); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	result, err := r.Result(ctx, "call", 1)
	if err != nil || result["status"] != "failed" || result["error"] != "execution failed" {
		t.Fatalf("result = %v, %v", result, err)
	}
	if err := r.Drain(func(_ AsyncResult, inject bool) error {
		if inject {
			t.Error("queried result injected again")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAsyncCloseJoinsAndIsolatesExecutions(t *testing.T) {
	exited := make(chan struct{})
	r, ctx := startAsyncFixture(t, func(ctx agent.Context) (map[string]any, error) {
		defer close(exited)
		<-ctx.Done()
		return map[string]any{"status": "aborted"}, nil
	})
	otherCtx, other := NewAsyncRuntime(t.Context())
	defer other.Close()
	if _, err := other.Result(otherCtx, "call", 1); err == nil {
		t.Fatal("cross-turn result lookup allowed")
	}
	if AsyncFromContext(WithoutAsyncRuntime(ctx)) != nil {
		t.Fatal("child inherited parent queue")
	}
	r.Close()
	r.Close()
	select {
	case <-exited:
	default:
		t.Fatal("Close returned before worker exited")
	}
	if err := r.Drain(func(result AsyncResult, _ bool) error {
		if !errors.Is(result.Err, context.Canceled) {
			t.Errorf("error = %v", result.Err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAsyncFastResultAndValidation(t *testing.T) {
	ctx, r := NewAsyncRuntime(t.Context())
	defer r.Close()
	var count atomic.Int32
	wrapped := WithAsyncExecution(asyncFixture{run: func(agent.Context) (map[string]any, error) {
		count.Add(1)
		return map[string]any{"result": "fast"}, nil
	}}).(asyncRunnable)
	for _, value := range []any{-1, 60001, 1.5, "10", nil} {
		if _, err := wrapped.Run(asyncTestContext{base: ctx, id: "bad"}, map[string]any{"yield_after_ms": value}); err == nil {
			t.Fatalf("accepted %v", value)
		}
	}
	if count.Load() != 0 {
		t.Fatal("invalid controls executed tool")
	}
	result, err := wrapped.Run(asyncTestContext{base: ctx, id: "fast"}, map[string]any{})
	if err != nil || result["result"] != "fast" || r.Pending() {
		t.Fatalf("fast = %v, %v", result, err)
	}
	if err := r.Drain(func(AsyncResult, bool) error { t.Fatal("sync result queued"); return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestAsyncRegistryOwnsGenericArgument(t *testing.T) {
	type input struct {
		Text string `json:"text"`
	}
	raw, err := functiontool.New[input, map[string]any](functiontool.Config{Name: "custom"}, func(_ agent.Context, in input) (map[string]any, error) {
		return map[string]any{"result": in.Text}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	reg := NewRegistry(Tool{Tool: raw, Meta: Metadata{Name: "custom", Async: true}})
	wrapped := reg.Entries()[0].Tool.(asyncRunnable)
	params := wrapped.Declaration().ParametersJsonSchema.(map[string]any)["properties"].(map[string]any)
	if params["yield_after_ms"] == nil || params["text"] == nil {
		t.Fatalf("schema = %v", params)
	}
	// A registry rebuilt from entries must not inject the reserved argument twice.
	clone := NewRegistry(reg.Entries()...)
	result, err := clone.Entries()[0].Tool.(asyncRunnable).Run(asyncTestContext{base: t.Context()}, map[string]any{"text": "strict business input", "yield_after_ms": 1})
	if err != nil || result["result"] != "strict business input" {
		t.Fatalf("sync fallback = %v, %v", result, err)
	}
	if reg.List()[0]["async"] != true {
		t.Fatal("capability absent from registry view")
	}
	entry := reg.Entries()[0]
	entry.Meta.Async = false
	reg.Add(entry)
	if reg.Entries()[0].Tool != raw || reg.List()[0]["async"] != false {
		t.Fatal("disabling capability did not restore original tool")
	}
}

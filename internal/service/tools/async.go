package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/adk/v2/tool/toolutils"
	"google.golang.org/genai"
)

const AsyncYieldAfter = 5 * time.Second

type asyncKey struct{}

// AsyncResult belongs to one turn. Final delivery and recording are tracked
// separately: a polling tool can deliver a result before the next model step.
type AsyncResult struct {
	ID           string
	InvocationID string
	Name         string
	Response     map[string]any
	Err          error
	Metadata     map[string]any
	ctx          context.Context
	prepared     bool
	done         chan struct{}
	detached     bool
	delivered    bool
	recorded     bool
}

// AsyncRuntime is owned by a turn, never by the process or workspace. Tools
// opted into it must honor cancellation and must not mutate ADK event actions.
type AsyncRuntime struct {
	mu         sync.Mutex
	jobs       map[string]*AsyncResult
	order      []*AsyncResult
	changed    chan struct{}
	wg         sync.WaitGroup
	cancel     context.CancelFunc
	ctx        context.Context
	yieldAfter time.Duration
	Finalize   func(agent.Context, tool.Tool, map[string]any, map[string]any, error) (map[string]any, error)
}

func NewAsyncRuntime(ctx context.Context) (context.Context, *AsyncRuntime) {
	ctx, cancel := context.WithCancel(ctx)
	r := &AsyncRuntime{jobs: map[string]*AsyncResult{}, changed: make(chan struct{}, 1), cancel: cancel, ctx: ctx, yieldAfter: AsyncYieldAfter}
	return context.WithValue(ctx, asyncKey{}, r), r
}

func AsyncFromContext(ctx context.Context) *AsyncRuntime {
	r, _ := ctx.Value(asyncKey{}).(*AsyncRuntime)
	return r
}

// WithoutAsyncRuntime prevents a separately owned runner from borrowing its
// parent's result queue. Runners without the continuation loop execute in sync.
func WithoutAsyncRuntime(ctx context.Context) context.Context {
	return context.WithValue(ctx, asyncKey{}, (*AsyncRuntime)(nil))
}

func (r *AsyncRuntime) Close() {
	r.cancel()
	r.wg.Wait()
}

func (r *AsyncRuntime) Owns(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobs[id] != nil
}

func IsAsyncPending(response map[string]any) bool {
	return response["status"] == "running" && response["async"] == true
}

func IsAsyncPlaceholder(id string, response map[string]any) bool {
	return IsAsyncPending(response) && response["call_id"] == id
}

func pendingResult(id string) map[string]any {
	return map[string]any{"async": true, "status": "running", "call_id": id,
		"message": "Execution continues. Continue independent work; use tool_result(call_id) before dependent work. The final result will otherwise be delivered automatically. Do not repeat the original call."}
}

// Pending includes completed results that the model has not received yet.
func (r *AsyncRuntime) Pending() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, j := range r.order {
		if j.detached && !j.delivered {
			return true
		}
	}
	return false
}

func (r *AsyncRuntime) Wait(ctx context.Context) error {
	for {
		r.mu.Lock()
		pending, ready := false, false
		for _, j := range r.order {
			if j.detached && !j.delivered {
				pending = true
				select {
				case <-j.done:
					ready = true
				default:
				}
			}
		}
		r.mu.Unlock()
		if !pending || ready {
			return ctx.Err()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.changed:
		}
	}
}

// Drain serializes persistence and automatic delivery against result queries.
// A failed append leaves the result available and propagates the storage error.
func (r *AsyncRuntime) Drain(save func(AsyncResult, bool) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, j := range r.order {
		if !j.detached || j.recorded {
			continue
		}
		select {
		case <-j.done:
		default:
			continue
		}
		if !j.prepared {
			event := &session.Event{InvocationID: j.InvocationID}
			event.Content = &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: j.ID}}}}
			AttachFileChanges(j.ctx, event)
			j.Metadata, j.prepared = event.CustomMetadata, true
		}
		if err := save(*j, !j.delivered); err != nil {
			return err
		}
		j.recorded, j.delivered = true, true
	}
	return nil
}

type asyncRunnable interface {
	tool.Tool
	Declaration() *genai.FunctionDeclaration
	Run(agent.Context, any) (map[string]any, error)
}

type asyncTool struct {
	asyncRunnable
	declaration    *genai.FunctionDeclaration
	declarationErr error
}

type executionContext struct {
	agent.Context
	lifetime context.Context
}

func (c executionContext) Done() <-chan struct{}       { return c.lifetime.Done() }
func (c executionContext) Err() error                  { return c.lifetime.Err() }
func (c executionContext) Deadline() (time.Time, bool) { return c.lifetime.Deadline() }

// WithAsyncExecution opts a cancellation-aware, action-free tool into bounded
// synchronous waiting. Without a turn runtime (e.g. MCP export), it stays sync.
// Approval wrappers must be outside this wrapper, before any goroutine starts.
func WithAsyncExecution(t tool.Tool) tool.Tool {
	if _, ok := t.(*asyncTool); ok {
		return t
	}
	runnable, ok := t.(asyncRunnable)
	if !ok {
		return t
	}
	decl, err := asyncDeclaration(runnable.Declaration())
	return &asyncTool{asyncRunnable: runnable, declaration: decl, declarationErr: err}
}

// Only the wrapper owns yield_after_ms. Business schemas and arguments remain
// unchanged, including strict additionalProperties and local schema references.
func asyncDeclaration(original *genai.FunctionDeclaration) (*genai.FunctionDeclaration, error) {
	if original == nil {
		return nil, fmt.Errorf("async tool requires a function declaration")
	}
	decl := *original
	source := original.ParametersJsonSchema
	if source == nil {
		source = original.Parameters
	}
	schema := map[string]any{"type": "object"}
	if source != nil {
		raw, err := json.Marshal(source)
		if err != nil {
			return nil, fmt.Errorf("encode async tool schema: %w", err)
		}
		if err := json.Unmarshal(raw, &schema); err != nil {
			return nil, fmt.Errorf("decode async tool schema: %w", err)
		}
		if schema == nil {
			schema = map[string]any{"type": "object"}
		}
	}
	properties, _ := schema["properties"].(map[string]any)
	if properties == nil {
		properties = map[string]any{}
		schema["properties"] = properties
	}
	if _, exists := properties["yield_after_ms"]; exists {
		return nil, fmt.Errorf("yield_after_ms is reserved for async execution")
	}
	properties["yield_after_ms"] = map[string]any{
		"type": "integer", "minimum": 0, "maximum": 60000,
		"description": "同步等待毫秒数，默认 5000，0 使用默认值，最大 60000；到期返回 running 与 call_id，后台继续执行；最终结果自动回填或通过 tool_result 获取，不改变工具执行超时。",
	}
	decl.Parameters, decl.ParametersJsonSchema = nil, schema
	return &decl, nil
}

func (t *asyncTool) Declaration() *genai.FunctionDeclaration { return t.declaration }

func (t *asyncTool) ProcessRequest(_ agent.Context, req *model.LLMRequest) error {
	if t.declarationErr != nil {
		return t.declarationErr
	}
	return toolutils.PackTool(req, t)
}

func (t *asyncTool) Run(ctx agent.Context, args any) (map[string]any, error) {
	if t.declarationErr != nil {
		return nil, t.declarationErr
	}
	r := AsyncFromContext(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	wait := AsyncYieldAfter
	if r != nil {
		wait = r.yieldAfter
	}
	businessArgs := args
	if input, ok := args.(map[string]any); ok {
		copy := make(map[string]any, len(input))
		for key, value := range input {
			if key != "yield_after_ms" {
				copy[key] = value
			}
		}
		businessArgs = copy
		if value, present := input["yield_after_ms"]; present {
			raw, err := json.Marshal(value)
			var ms int
			if err != nil || json.Unmarshal(raw, &ms) != nil || value == nil || ms < 0 || ms > 60000 {
				return nil, fmt.Errorf("yield_after_ms must be an integer between 0 and 60000")
			}
			if ms > 0 {
				wait = time.Duration(ms) * time.Millisecond
			}
		}
	}
	if r == nil || ctx.FunctionCallID() == "" {
		return t.asyncRunnable.Run(ctx, businessArgs)
	}
	j := &AsyncResult{ID: ctx.FunctionCallID(), InvocationID: ctx.InvocationID(), Name: t.Name(), done: make(chan struct{})}
	r.mu.Lock()
	if r.jobs[j.ID] != nil {
		r.mu.Unlock()
		return nil, fmt.Errorf("duplicate tool call ID %q", j.ID)
	}
	r.jobs[j.ID] = j
	r.order = append(r.order, j)
	r.wg.Add(1)
	r.mu.Unlock()
	// ADK may end a model invocation while this execution is still pending.
	// Preserve its values and tool identity, but use the owning turn's lifetime.
	workerCtx := executionContext{Context: ctx, lifetime: r.ctx}
	j.ctx = workerCtx
	go func() {
		defer r.wg.Done()
		response, err := t.asyncRunnable.Run(workerCtx, businessArgs)
		// Some adapters encode cancellation in their response instead of an
		// error. A cancelled owning turn must never publish a success result.
		if err == nil && workerCtx.Err() != nil {
			err = workerCtx.Err()
		}
		if r.Finalize != nil {
			input, _ := args.(map[string]any)
			response, err = r.Finalize(workerCtx, t, input, response, err)
		}
		r.mu.Lock()
		j.Response, j.Err = response, err
		close(j.done)
		r.mu.Unlock()
		select {
		case r.changed <- struct{}{}:
		default:
		}
	}()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-j.done:
		r.mu.Lock()
		j.delivered = true
		r.mu.Unlock()
		return j.Response, j.Err
	case <-ctx.Done():
		r.mu.Lock()
		j.detached = true
		r.mu.Unlock()
		return nil, ctx.Err()
	case <-timer.C:
		r.mu.Lock()
		defer r.mu.Unlock()
		// Prefer a result that completed at the waiting boundary.
		select {
		case <-j.done:
			j.delivered = true
			return j.Response, j.Err
		default:
		}
		j.detached = true
		return pendingResult(j.ID), nil
	}
}

type asyncResultInput struct {
	CallID    string `json:"call_id" jsonschema:"ID returned by a running tool in this turn"`
	TimeoutMs int    `json:"timeout_ms,omitempty" jsonschema:"Wait up to this many milliseconds, default 1000, maximum 60000; does not stop execution"`
}

func AsyncResultTool() (tool.Tool, error) {
	return functiontool.New[asyncResultInput, map[string]any](functiontool.Config{
		Name: "tool_result", Description: "Read or wait for a running tool's final result. A running response preserves automatic delivery. Use before dependent work; otherwise continue independent work and the result arrives automatically.",
	}, func(ctx agent.Context, in asyncResultInput) (map[string]any, error) {
		r := AsyncFromContext(ctx)
		if r == nil {
			return nil, fmt.Errorf("no active tool execution turn")
		}
		return r.Result(ctx, in.CallID, in.TimeoutMs)
	})
}

func (r *AsyncRuntime) Result(ctx context.Context, id string, waitMS int) (map[string]any, error) {
	if waitMS < 0 || waitMS > 60000 {
		return nil, fmt.Errorf("timeout_ms must be between 0 and 60000")
	}
	if waitMS == 0 {
		waitMS = 1000
	}
	r.mu.Lock()
	j := r.jobs[id]
	if j == nil || !j.detached {
		r.mu.Unlock()
		return nil, fmt.Errorf("unknown background call %q in this turn", id)
	}
	r.mu.Unlock()
	timer := time.NewTimer(time.Duration(waitMS) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return pendingResult(id), nil
	case <-j.done:
		r.mu.Lock()
		defer r.mu.Unlock()
		if j.delivered {
			return map[string]any{"call_id": id, "status": "delivered", "message": "Final result already delivered in this conversation."}, nil
		}
		j.delivered = true
		return AsyncResponse(*j), nil
	}
}

func AsyncResponse(j AsyncResult) map[string]any {
	status := "completed"
	if j.Err != nil || j.Response["error"] != nil || j.Response["status"] == "failed" {
		status = "failed"
	}
	out := map[string]any{"call_id": j.ID, "name": j.Name, "status": status, "result": j.Response}
	if j.Err != nil {
		out["error"] = j.Err.Error()
	}
	return out
}

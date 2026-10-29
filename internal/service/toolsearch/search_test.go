package toolsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
)

type testContext struct {
	agent.Context
	base context.Context
	app  string
	id   string
}

func newTestContext(app, id string) *testContext {
	return &testContext{base: context.Background(), app: app, id: id}
}

func (c *testContext) Deadline() (time.Time, bool) { return c.base.Deadline() }
func (c *testContext) Done() <-chan struct{}       { return c.base.Done() }
func (c *testContext) Err() error                  { return c.base.Err() }
func (c *testContext) Value(key any) any           { return c.base.Value(key) }
func (c *testContext) AppName() string             { return c.app }
func (c *testContext) UserID() string              { return "user" }
func (c *testContext) SessionID() string           { return c.id }

func (c *testContext) ToolConfirmation() *toolconfirmation.ToolConfirmation { return nil }

type testToolset struct {
	tools  []tool.Tool
	err    error
	calls  atomic.Int32
	closes atomic.Int32
}

func (s *testToolset) Name() string { return "fixture" }
func (s *testToolset) Tools(agent.ReadonlyContext) ([]tool.Tool, error) {
	s.calls.Add(1)
	return s.tools, s.err
}
func (s *testToolset) Close() error { s.closes.Add(1); return nil }

func fixtureTool(t *testing.T, name, description string) tool.Tool {
	t.Helper()
	created, err := functiontool.New[struct{}, map[string]any](
		functiontool.Config{Name: name, Description: description},
		func(agent.Context, struct{}) (map[string]any, error) {
			return map[string]any{"originalName": name}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func toolDefinitions(t *testing.T, set *Set, ctx agent.ReadonlyContext) []byte {
	t.Helper()
	tools, err := set.Tools(ctx)
	if err != nil || len(tools) != 2 || tools[0].Name() != Name || tools[1].Name() != CallName {
		t.Fatalf("broker tools = %v, error=%v", tools, err)
	}
	definitions := []any{}
	for _, candidate := range tools {
		definitions = append(definitions, candidate.(functionTool).Declaration())
	}
	data, err := json.Marshal(definitions)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSearchAndCallKeepDefinitionsStable(t *testing.T) {
	idea := &testToolset{tools: []tool.Tool{
		fixtureTool(t, "find_references", "查找 Java 符号引用 Find symbol references"),
		fixtureTool(t, "debug_step", "Step the debugger"),
	}}
	codegraph := &testToolset{tools: []tool.Tool{fixtureTool(t, "explore_graph", "Explore call graph")}}
	var denied atomic.Bool
	sources := []Source{
		{Name: "idea", Toolset: idea, Filter: func(ctx agent.ReadonlyContext, candidate tool.Tool) bool {
			return ctx.AppName() == "project-a" && (!denied.Load() || candidate.Name() != "find_references")
		}},
		{Name: "codegraph", Toolset: codegraph},
	}
	set, err := New(sources)
	if err != nil {
		t.Fatal(err)
	}
	ctx := newTestContext("project-a", "conversation")
	initial := toolDefinitions(t, set, ctx)
	if idea.calls.Load()+codegraph.calls.Load() != 0 {
		t.Fatal("ordinary model request connected to MCP")
	}
	result, err := set.Search(ctx, SearchInput{Query: "查找符号引用", Limit: 1})
	if err != nil || len(result.Tools) != 1 || result.Tools[0].Name != "idea/find_references" {
		t.Fatalf("search = %+v, error=%v", result, err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"parameters":`) {
		t.Fatal("search omitted the callable tool definition")
	}
	called, err := set.Call(ctx, CallInput{Name: result.Tools[0].Name, Arguments: map[string]any{}})
	if err != nil || called["originalName"] != "find_references" {
		t.Fatalf("broker dispatch = %v, error=%v", called, err)
	}
	if !bytes.Equal(initial, toolDefinitions(t, set, ctx)) {
		t.Fatal("search or call changed the model-facing definitions")
	}
	_, err = set.Call(newTestContext("project-b", "conversation"), CallInput{Name: result.Tools[0].Name})
	if err == nil {
		t.Fatal("dispatcher bypassed the source's workspace restriction")
	}
	if idea.calls.Load() != 1 || codegraph.calls.Load() != 1 {
		t.Fatal("catalog was fetched repeatedly in the same turn")
	}
	denied.Store(true)
	_, err = set.Call(ctx, CallInput{Name: "idea/find_references"})
	if err == nil {
		t.Fatal("a newly disallowed tool remained callable")
	}
	result, err = set.Search(ctx, SearchInput{Query: "find_references"})
	if err != nil || len(result.Tools) != 0 {
		t.Fatal("search exposed a disallowed tool")
	}
	set.Close()
	set.Close()
	if idea.closes.Load() != 1 || codegraph.closes.Load() != 1 {
		t.Fatal("source connections were not closed exactly once")
	}
}

func TestCallKnownReferenceLoadsOnlyItsSource(t *testing.T) {
	first := &testToolset{tools: []tool.Tool{fixtureTool(t, "read", "Read from first source")}}
	second := &testToolset{tools: []tool.Tool{fixtureTool(t, "read", "Read from second source")}}
	set, err := New([]Source{{Name: "first", Toolset: first}, {Name: "second", Toolset: second}})
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	ctx := newTestContext("project", "session")
	_, err = set.Call(ctx, CallInput{Name: "second/read"})
	if err != nil || first.calls.Load() != 0 || second.calls.Load() != 1 {
		t.Fatalf("cold call = %v, source loads=%d/%d", err, first.calls.Load(), second.calls.Load())
	}
	_, err = set.Call(ctx, CallInput{Name: "unknown/read"})
	if err == nil {
		t.Fatal("unknown server was dispatched")
	}
	withoutSources, err := New(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer withoutSources.Close()
	if !bytes.Equal(toolDefinitions(t, set, ctx), toolDefinitions(t, withoutSources, ctx)) {
		t.Fatal("MCP configuration changed the broker's tool definitions")
	}
}

func TestCallValidatesNestedSchemaBeforeDispatch(t *testing.T) {
	var executions atomic.Int32
	candidate, err := functiontool.New[struct {
		Value string `json:"value"`
	}, map[string]any](functiontool.Config{Name: "validated", Description: "Requires a string"},
		func(_ agent.Context, input struct {
			Value string `json:"value"`
		}) (map[string]any, error) {
			executions.Add(1)
			return map[string]any{"value": input.Value}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	set, err := New([]Source{{Name: "fixture", Toolset: &testToolset{tools: []tool.Tool{candidate}}}})
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	ctx := newTestContext("project", "session")
	for _, args := range []map[string]any{{}, {"value": 42}} {
		if _, err := set.Call(ctx, CallInput{Name: "fixture/validated", Arguments: args}); err == nil {
			t.Fatalf("invalid parameters were accepted: %v", args)
		}
	}
	if executions.Load() != 0 {
		t.Fatal("invalid arguments reached the remote tool")
	}
	output, err := set.Call(ctx, CallInput{Name: "fixture/validated", Arguments: map[string]any{"value": "valid"}})
	if err != nil || output["value"] != "valid" || executions.Load() != 1 {
		t.Fatalf("valid dispatch = %v, error=%v", output, err)
	}
}

func TestUnavailableSourcesDoNotExposeConnectionDetails(t *testing.T) {
	broken := &testToolset{err: errors.New("private-url?secret=credential")}
	healthy := &testToolset{tools: []tool.Tool{fixtureTool(t, "lookup", "Look up a reference")}}
	set, err := New([]Source{{Name: "broken", Toolset: broken}, {Name: "healthy", Toolset: healthy}})
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	result, err := set.Search(newTestContext("project", "session"), SearchInput{Query: "lookup"})
	if err != nil || len(result.Tools) != 1 || len(result.UnavailableSources) != 1 || result.UnavailableSources[0] != "broken" {
		t.Fatalf("partial search = %+v, error=%v", result, err)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "credential") {
		t.Fatal("transport error leaked into model context")
	}
}

func TestQualifiedReferencesAreUnambiguous(t *testing.T) {
	cases := [][2]string{
		{"idea", "read"}, {"filesystem", "read"},
		{"a__b", "c"}, {"a", "b__c"},
		{"a/b", "c"}, {"a", "b/c"},
		{"idea", strings.Repeat("a", 90)},
	}
	seen := map[string]bool{}
	for _, pair := range cases {
		name := QualifiedName(pair[0], pair[1])
		if seen[name] || name != QualifiedName(pair[0], pair[1]) {
			t.Fatalf("invalid reference: %q", name)
		}
		server, tool, _ := strings.Cut(name, "/")
		server, _ = url.PathUnescape(server)
		tool, _ = url.PathUnescape(tool)
		if server != pair[0] || tool != pair[1] {
			t.Fatalf("ambiguous reference: %q", name)
		}
		seen[name] = true
	}
}

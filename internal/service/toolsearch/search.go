// Package toolsearch provides a fixed search-and-call interface to deferred MCP tools.
package toolsearch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
)

const (
	Name         = "tool_search"
	CallName     = "call_tool"
	DefaultLimit = 5
	MaxResults   = 8
)

type Source struct {
	Name    string
	Toolset tool.Toolset
	Timeout time.Duration
	Filter  tool.Predicate
}

type SearchInput struct {
	Query string `json:"query" jsonschema:"Describe the action or capability needed; include a server name or tool name when known."`
	Limit int    `json:"limit,omitempty" jsonschema:"Maximum definitions to return. Default 5, maximum 8."`
}

type Match struct {
	Name        string `json:"name"`
	Server      string `json:"server"`
	Tool        string `json:"tool"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

type SearchResult struct {
	Tools              []Match  `json:"tools"`
	AvailableTools     int      `json:"availableTools"`
	UnavailableSources []string `json:"unavailableSources,omitempty"`
	Note               string   `json:"note"`
	Error              string   `json:"error,omitempty"`
}

type sourceState struct {
	Source
	attempted bool
	failed    bool
	entries   []*entry
}

type entry struct {
	name        string
	source      *sourceState
	tool        functionTool
	parameters  any
	resolved    bool
	schema      *jsonschema.Resolved
	schemaError error
}

// Set owns a turn's MCP connections. Its two model-facing tools never change;
// discovered definitions travel only in tool_search results.
type Set struct {
	mu      sync.Mutex
	sources []*sourceState
	search  tool.Tool
	call    tool.Tool
	closed  bool
}

type CallInput struct {
	Name      string         `json:"name" jsonschema:"Exact qualified tool name returned by tool_search, such as idea/find_references."`
	Arguments map[string]any `json:"arguments" jsonschema:"Arguments matching the selected tool's parameters JSON Schema. Use an empty object for tools without parameters."`
}

func New(sources []Source) (*Set, error) {
	s := &Set{}
	names := map[string]bool{}
	for _, source := range sources {
		if source.Name == "" || source.Toolset == nil || names[source.Name] {
			return nil, fmt.Errorf("tool search requires uniquely named, non-nil sources")
		}
		names[source.Name] = true
		if source.Timeout <= 0 {
			source.Timeout = 15 * time.Second
		}
		s.sources = append(s.sources, &sourceState{Source: source})
	}
	sort.Slice(s.sources, func(i, j int) bool { return s.sources[i].Name < s.sources[j].Name })
	search, err := functiontool.New[SearchInput, SearchResult](
		functiontool.Config{Name: Name, Description: "Search available MCP tools by capability, action, server or tool name. Returns matching tool definitions, including complete parameters JSON Schemas. Invoke a result using call_tool(name, arguments). Remote tools are never added to the request tool list."},
		func(ctx agent.Context, input SearchInput) (SearchResult, error) {
			result, err := s.Search(ctx, input)
			if err != nil && ctx.Err() == nil {
				result.Error = err.Error()
				return result, nil
			}
			return result, err
		},
	)
	if err != nil {
		return nil, err
	}
	call, err := functiontool.New[CallInput, map[string]any](
		functiontool.Config{Name: CallName, Description: "Call an MCP tool using the exact qualified name and arguments from its tool_search definition. Arguments are validated against that tool's JSON Schema; normal permissions and confirmation still apply."},
		func(ctx agent.Context, input CallInput) (map[string]any, error) {
			result, err := s.Call(ctx, input)
			if err != nil && ctx.Err() == nil && !errors.Is(err, tool.ErrConfirmationRequired) && !errors.Is(err, tool.ErrConfirmationRejected) {
				return map[string]any{"success": false, "error": err.Error()}, nil
			}
			return result, err
		},
	)
	if err != nil {
		return nil, err
	}
	s.search, s.call = search, call
	return s, nil
}

func (s *Set) Name() string { return "deferred-mcp-tools" }

func (s *Set) Tools(agent.ReadonlyContext) ([]tool.Tool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("tool search is closed")
	}
	return []tool.Tool{s.search, s.call}, nil
}

func (s *Set) Search(ctx agent.Context, input SearchInput) (SearchResult, error) {
	query := strings.TrimSpace(input.Query)
	result := SearchResult{Tools: []Match{}}
	if query == "" || utf8.RuneCountInString(query) > 512 {
		return result, fmt.Errorf("query must contain 1 to 512 characters")
	}
	if input.Limit < 0 || input.Limit > MaxResults {
		return result, fmt.Errorf("limit must be between 1 and %d, or omitted", MaxResults)
	}
	limit := input.Limit
	if limit == 0 {
		limit = DefaultLimit
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return result, errors.New("tool search is closed")
	}
	s.load(ctx, func(*sourceState) bool { return true })
	if err := ctx.Err(); err != nil {
		return result, err
	}
	available := s.available(ctx)
	entries := make([]*entry, 0, len(available))
	for _, entry := range available {
		entries = append(entries, entry)
	}
	matches := rank(entries, query, limit)
	for _, entry := range matches {
		result.Tools = append(result.Tools, Match{
			Name: entry.name, Server: entry.source.Name, Tool: entry.tool.Name(),
			Description: entry.tool.Description(), Parameters: entry.parameters,
		})
	}
	result.AvailableTools = len(available)
	for _, source := range s.sources {
		if source.failed {
			result.UnavailableSources = append(result.UnavailableSources, source.Name)
		}
	}
	result.Note = "Invoke a returned definition with call_tool(name, arguments). The request tool list stays unchanged."
	if len(matches) == 0 {
		result.Note = "No matching tools. Try another action, keyword or server name."
	}
	return result, nil
}

func (s *Set) available(ctx agent.ReadonlyContext) map[string]*entry {
	out := map[string]*entry{}
	for _, source := range s.sources {
		for _, entry := range source.entries {
			if source.Filter == nil || source.Filter(ctx, entry.tool) {
				out[entry.name] = entry
			}
		}
	}
	return out
}

// load runs under s.mu; workers own separate source states until they finish.
func (s *Set) load(ctx agent.ReadonlyContext, wanted func(*sourceState) bool) {
	var workers sync.WaitGroup
	slots := make(chan struct{}, 4)
	for _, source := range s.sources {
		if source.attempted || !wanted(source) {
			continue
		}
		source.attempted = true
		workers.Go(func() {
			parent := context.Context(context.Background())
			if ctx != nil {
				parent = ctx
			}
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-parent.Done():
				source.failed = true
				return
			}
			timed, cancel := context.WithTimeout(parent, source.Timeout)
			defer cancel()
			tools, err := source.Toolset.Tools(timedContext{ReadonlyContext: ctx, ctx: timed})
			if err != nil {
				source.failed = true
				return
			}
			seen := map[string]bool{}
			for _, t := range tools {
				callable, ok := t.(functionTool)
				if !ok || callable.Declaration() == nil || t.Name() == "" || seen[t.Name()] {
					continue
				}
				seen[t.Name()] = true
				source.entries = append(source.entries, &entry{
					name: QualifiedName(source.Name, t.Name()), source: source,
					tool: callable, parameters: parameterSchema(callable.Declaration()),
				})
			}
		})
	}
	workers.Wait()
}

func (s *Set) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var errs []error
	for _, source := range s.sources {
		if closer, ok := source.Toolset.(io.Closer); ok {
			errs = append(errs, closer.Close())
		}
	}
	return errors.Join(errs...)
}

type timedContext struct {
	agent.ReadonlyContext
	ctx context.Context
}

func (c timedContext) Deadline() (time.Time, bool) { return c.ctx.Deadline() }
func (c timedContext) Done() <-chan struct{}       { return c.ctx.Done() }
func (c timedContext) Err() error                  { return c.ctx.Err() }
func (c timedContext) Value(key any) any           { return c.ctx.Value(key) }

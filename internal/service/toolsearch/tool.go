package toolsearch

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"
)

type functionTool interface {
	tool.Tool
	Declaration() *genai.FunctionDeclaration
	Run(agent.Context, any) (map[string]any, error)
}

// QualifiedName identifies a remote tool without imposing function-name limits
// on the reference passed to call_tool.
func QualifiedName(server, name string) string {
	return url.PathEscape(server) + "/" + url.PathEscape(name)
}

func (s *Set) Call(ctx agent.Context, input CallInput) (map[string]any, error) {
	server, _, found := strings.Cut(input.Name, "/")
	if !found || server == "" {
		return nil, errors.New("use the exact qualified name returned by tool_search")
	}
	selected, err := s.lookup(ctx, input.Name, server)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(input.Arguments)
	if err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	args := map[string]any{}
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if args == nil {
		args = map[string]any{}
	}
	if err := selected.schema.Validate(args); err != nil {
		return nil, fmt.Errorf("arguments for %s do not match its parameters schema: %w", input.Name, err)
	}
	// Delegate to the original MCP tool so confirmation and transport metadata survive.
	return selected.tool.Run(ctx, args)
}

func (s *Set) lookup(ctx agent.Context, name, server string) (*entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("tool search is closed")
	}
	s.load(ctx, func(source *sourceState) bool { return url.PathEscape(source.Name) == server })
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, source := range s.sources {
		if url.PathEscape(source.Name) != server {
			continue
		}
		for _, candidate := range source.entries {
			if candidate.name != name || source.Filter != nil && !source.Filter(ctx, candidate.tool) {
				continue
			}
			if !candidate.resolved {
				candidate.resolved = true
				var schema jsonschema.Schema
				raw, err := json.Marshal(candidate.parameters)
				if err == nil {
					err = json.Unmarshal(raw, &schema)
				}
				if err == nil {
					candidate.schema, err = schema.Resolve(nil)
				}
				candidate.schemaError = err
			}
			if candidate.schemaError != nil {
				return nil, fmt.Errorf("parameters schema for %s cannot be validated", name)
			}
			return candidate, nil
		}
	}
	return nil, fmt.Errorf("tool %q is unknown, disabled or unavailable; use tool_search", name)
}

func parameterSchema(declaration *genai.FunctionDeclaration) any {
	if declaration.ParametersJsonSchema != nil {
		return declaration.ParametersJsonSchema
	}
	if declaration.Parameters == nil {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	// GenAI's schema encodes type names in upper case; JSON Schema uses lower case.
	raw, _ := json.Marshal(declaration.Parameters)
	var value any
	_ = json.Unmarshal(raw, &value)
	normalizeTypes(value)
	return value
}

func normalizeTypes(value any) {
	switch node := value.(type) {
	case map[string]any:
		if kind, ok := node["type"].(string); ok {
			node["type"] = strings.ToLower(kind)
		}
		for _, child := range node {
			normalizeTypes(child)
		}
	case []any:
		for _, child := range node {
			normalizeTypes(child)
		}
	}
}

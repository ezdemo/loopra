package provider

import (
	"encoding/json"
	"fmt"
)

// Invalid arguments are a model/protocol error, not executable tool input.
// Wrapping them as _raw hides the parse failure behind a schema validation error
// and can cause the agent to repeat the same malformed call indefinitely.
func toolArguments(protocol, name, id, raw string) (map[string]any, error) {
	args := map[string]any{}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &args); err != nil {
			return nil, fmt.Errorf("%s tool %q (%s) arguments JSON: %w", protocol, name, id, err)
		}
	}
	if args == nil {
		return nil, fmt.Errorf("%s tool %q (%s) arguments must be a JSON object", protocol, name, id)
	}
	return args, nil
}

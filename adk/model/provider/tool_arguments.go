package provider

import (
	"encoding/json"
	"fmt"

	"google.golang.org/genai"
)

// Invalid arguments must never become executable input. The caller retains the
// parse error on the Part so the runtime can return it as a tool result.
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

const toolArgumentErrorKey = "loopra.toolArgumentError"
const toolArgumentRawKey = "loopra.toolArgumentRaw"

func toolCallPart(protocol, name, id, raw string) *genai.Part {
	args, err := toolArguments(protocol, name, id, raw)
	part := &genai.Part{FunctionCall: &genai.FunctionCall{ID: id, Name: name, Args: args}}
	if err != nil {
		part.FunctionCall.Args = map[string]any{}
		part.PartMetadata = map[string]any{
			toolArgumentErrorKey: err.Error(),
			toolArgumentRawKey:   raw,
		}
	}
	return part
}

// ToolArgumentError reports a parse failure retained by an adapter. The runtime
// must return it to the model without executing the corresponding tool.
func ToolArgumentError(part *genai.Part) string {
	if part == nil || part.FunctionCall == nil {
		return ""
	}
	message, _ := part.PartMetadata[toolArgumentErrorKey].(string)
	if message == "" {
		return ""
	}
	raw, _ := part.PartMetadata[toolArgumentRawKey].(string)
	return fmt.Sprintf("%s. Raw arguments: %s. Correct the arguments and retry with a JSON object.", message, raw)
}

// Replay malformed argument strings faithfully; replacing them with {} hides
// what the model needs to correct. They remain strings in the wire envelope.
func marshalToolArguments(part *genai.Part) ([]byte, error) {
	if ToolArgumentError(part) != "" {
		raw, _ := part.PartMetadata[toolArgumentRawKey].(string)
		return []byte(raw), nil
	}
	return json.Marshal(part.FunctionCall.Args)
}

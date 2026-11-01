package provider

import (
	"encoding/json"
	"reflect"

	"google.golang.org/adk/v2/model"
)

// PreparePrefixReplay freezes a summary request's wire body only when its
// history, before the final instruction, is an exact prefix of a sent request.
// Eligibility is not a promise that a provider still holds that prefix in cache.
func PreparePrefixReplay(llm model.LLM, previous string, req *model.LLMRequest) bool {
	var body map[string]any
	var err error
	var protocol string
	switch a := llm.(type) {
	case *chatAdapter:
		protocol = ProtocolChatCompletions
		body, err = a.buildBody(req, newCallIDTracker(), a.config.Settings.Snapshot(), false)
	case *responsesAdapter:
		protocol = ProtocolResponses
		body, err = a.buildBody(req, newCallIDTracker(), a.config.Settings.Snapshot(), false)
	case *anthropicAdapter:
		protocol = ProtocolAnthropic
		body, err = a.buildBody(req, newCallIDTracker(), a.config.Settings.Snapshot(), false)
	default:
		return false
	}
	if err != nil {
		return false
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return false
	}
	before, after, same := comparablePrompts(protocol, previous, string(raw))
	if !same || len(after) < 2 || len(before) < len(after)-1 {
		return false
	}
	for i, item := range after[:len(after)-1] {
		if !reflect.DeepEqual(item, before[i]) {
			return false
		}
	}
	SetWireBody(req, body)
	return true
}

// CommonPromptMessages measures an unchanged serialized message prefix for
// diagnostics. Changed instructions, tools, model, or other envelope fields
// make this zero even when some history messages happen to match.
func CommonPromptMessages(protocol, previous, current string) int {
	before, after, same := comparablePrompts(protocol, previous, current)
	if !same {
		return 0
	}
	n := 0
	for n < len(before) && n < len(after) && reflect.DeepEqual(before[n], after[n]) {
		n++
	}
	return n
}

func comparablePrompts(protocol, previous, current string) ([]any, []any, bool) {
	var before, after map[string]any
	if json.Unmarshal([]byte(previous), &before) != nil ||
		json.Unmarshal([]byte(current), &after) != nil {
		return nil, nil, false
	}
	key := "messages"
	if protocol == ProtocolResponses {
		key = "input"
	}
	left, okLeft := before[key].([]any)
	right, okRight := after[key].([]any)
	if !okLeft || !okRight {
		return nil, nil, false
	}
	delete(before, key)
	delete(after, key)
	// These control transport/output, not the model-visible input prefix.
	for _, key := range []string{"stream", "stream_options", "max_tokens", "max_completion_tokens", "max_output_tokens"} {
		delete(before, key)
		delete(after, key)
	}
	return left, right, reflect.DeepEqual(before, after)
}

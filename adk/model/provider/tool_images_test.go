package provider

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"testing"

	"google.golang.org/genai"
)

func TestToolImagesReachAllWireProtocolsAfterToolResults(t *testing.T) {
	for _, protocol := range []string{ProtocolChatCompletions, ProtocolResponses, ProtocolAnthropic} {
		t.Run(protocol, func(t *testing.T) {
			data := []byte("fixture-image")
			response := &genai.FunctionResponse{ID: "image-1", Name: "read_image", Response: map[string]any{"result": "attached"}, Parts: []*genai.FunctionResponsePart{genai.NewFunctionResponsePartFromBytes(data, "image/png")}}
			request := reqWith([]*genai.Content{
				userContent("look"),
				{Role: genai.RoleModel, Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "image-1", Name: "read_image"}}, {FunctionCall: &genai.FunctionCall{ID: "other", Name: "read"}}}},
				{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: response}, {FunctionResponse: &genai.FunctionResponse{ID: "other", Name: "read", Response: map[string]any{"result": "text"}}}}},
			})
			before, _ := json.Marshal(request)
			cfg := Config{APIKey: "test", DefaultModel: "test-model", ImageInput: true}
			tracker := newCallIDTracker()
			var body map[string]any
			var err error
			switch protocol {
			case ProtocolChatCompletions:
				body, err = (&chatAdapter{config: cfg}).buildBody(request, tracker, SettingsSnapshot{}, false)
			case ProtocolResponses:
				body, err = (&responsesAdapter{config: cfg}).buildBody(request, tracker, SettingsSnapshot{}, false)
			case ProtocolAnthropic:
				body, err = (&anthropicAdapter{config: cfg}).buildBody(request, tracker, SettingsSnapshot{}, false)
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(body)
			if !bytes.Contains(raw, []byte(base64.StdEncoding.EncodeToString(data))) {
				t.Fatalf("image missing: %s", raw)
			}
			after, _ := json.Marshal(request)
			if !bytes.Equal(before, after) {
				t.Fatal("mutated stored request")
			}
			if protocol == ProtocolChatCompletions {
				items := body["messages"].([]wireChatMessage)
				if len(items) != 5 || items[2].Role != "tool" || items[3].Role != "tool" || items[4].Role != "user" {
					t.Fatalf("messages=%v", items)
				}
				if items[2].Content != "attached" {
					t.Fatalf("base64 in tool text: %v", items[2])
				}
			}
			if protocol == ProtocolResponses {
				items := body["input"].([]any)
				last := items[len(items)-1].(map[string]any)["content"].([]any)
				if _, ok := last[1].(map[string]any)["image_url"].(string); !ok {
					t.Fatalf("invalid Responses image URL: %v", last)
				}
			}
		})
	}
}

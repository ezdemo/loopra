package agent

import (
	"testing"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

func TestFoldRequestResultsPreservesTranscriptAndOtherParts(t *testing.T) {
	response := &genai.Part{FunctionResponse: &genai.FunctionResponse{ID: "call-one", Name: "read", Response: map[string]any{"text": "ORIGINAL"}}}
	image := &genai.Part{InlineData: &genai.Blob{MIMEType: "image/png", Data: []byte{1, 2, 3}}}
	original := &genai.Content{Role: "user", Parts: []*genai.Part{response, image}}
	untouched := &genai.Content{Role: "model", Parts: []*genai.Part{{Text: "keep"}}}
	request := &model.LLMRequest{Contents: []*genai.Content{original, untouched}}
	foldRequestToolResults(request, []string{"call-one"})
	folded := request.Contents[0].Parts[0].FunctionResponse
	if folded.ID != "call-one" || folded.Name != "read" || folded.Response["text"] == "ORIGINAL" {
		t.Fatalf("folded=%v", folded)
	}
	if original.Parts[0].FunctionResponse.Response["text"] != "ORIGINAL" || request.Contents[0] == original {
		t.Fatal("session record was mutated")
	}
	if request.Contents[0].Parts[1] != image || request.Contents[1] != untouched {
		t.Fatal("unrelated content was altered")
	}
}

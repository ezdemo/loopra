package provider

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/genai"
)

func TestPrefixReplayChecksFinalPayloadForEveryProtocol(t *testing.T) {
	for _, protocol := range []string{ProtocolChatCompletions, ProtocolResponses, ProtocolAnthropic} {
		t.Run(protocol, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"output":[],"content":[{"type":"text","text":"ok"}],"usage":{}}`)
			}))
			defer server.Close()
			llm, err := NewLLM(testChannel(protocol, server.URL), &Options{})
			if err != nil {
				t.Fatal(err)
			}
			contents := []*genai.Content{
				userContent(strings.Repeat("earlier context ", 100)),
				{Role: genai.RoleModel, Parts: []*genai.Part{{Text: "earlier answer"}}},
				userContent("keep this tail"),
			}
			first := reqWith(contents, echoToolDecl())
			var wire string
			firstObserver, secondObserver := 0, 0
			SetRequestObserver(first, func(body string) { wire = body; firstObserver++ })
			AddRequestObserver(first, func(body string) {
				secondObserver++
				if body == "" {
					t.Error("missing body")
				}
			})
			for _, err := range llm.GenerateContent(context.Background(), first, false) {
				if err != nil {
					t.Fatal(err)
				}
			}
			if firstObserver != 1 || secondObserver != 1 {
				t.Fatal("independent observers did not both run")
			}
			summary := reqWith(append(contents[:2:2], userContent("summarize")), echoToolDecl())
			if !PreparePrefixReplay(llm, wire, summary) {
				t.Fatal("unchanged system/tools/history prefix was rejected")
			}
			TakeWireBody(summary)
			summary.Config.SystemInstruction = genai.NewContentFromText("changed policy", genai.RoleUser)
			if PreparePrefixReplay(llm, wire, summary) {
				t.Fatal("changed system was marked reusable")
			}
			summary = reqWith(append(contents[:2:2], userContent("summarize")), echoToolDecl())
			summary.Config.Tools = nil
			if PreparePrefixReplay(llm, wire, summary) {
				t.Fatal("changed tools were marked reusable")
			}
			summary = reqWith([]*genai.Content{contents[1], userContent("summarize")}, echoToolDecl())
			if PreparePrefixReplay(llm, wire, summary) {
				t.Fatal("a non-prefix region was marked reusable")
			}
			if CommonPromptMessages(protocol, wire, wire) == 0 {
				t.Fatal("unchanged request did not retain a common prefix")
			}
		})
	}
}

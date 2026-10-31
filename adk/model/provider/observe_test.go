package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/genai"
)

func TestRequestObserverSeesFinalWireBodyForEveryProtocol(t *testing.T) {
	for _, protocol := range []string{ProtocolChatCompletions, ProtocolResponses, ProtocolAnthropic} {
		t.Run(protocol, func(t *testing.T) {
			var received string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				received = string(raw)
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"output":[],"content":[],"usage":{}}`)
			}))
			defer server.Close()
			llm, err := NewLLM(testChannel(protocol, server.URL), &Options{})
			if err != nil {
				t.Fatal(err)
			}
			request := reqWith([]*genai.Content{userContent("original")}, echoToolDecl())
			SetWireBody(request, map[string]any{"model": "rewritten", "messages": []any{map[string]any{"role": "user", "content": "FINAL"}}})
			calls := 0
			observed := ""
			SetRequestObserver(request, func(body string) { calls++; observed = body })
			if _, err := collectLLM(llm, request, false); err != nil {
				t.Fatal(err)
			}
			if calls != 1 || observed != received || !strings.Contains(observed, "FINAL") || strings.Contains(observed, "sk-test") {
				t.Fatalf("calls=%d observed=%s received=%s", calls, observed, received)
			}
			var decoded map[string]any
			if json.Unmarshal([]byte(observed), &decoded) != nil || decoded["model"] != "rewritten" {
				t.Fatal("observer did not see replacement JSON")
			}
			SetRequestObserver(request, func(string) { panic("bad observer") })
			if _, err := collectLLM(llm, request, false); err != nil {
				t.Fatalf("observer broke request: %v", err)
			}
			if strings.Contains(received, "FINAL") {
				t.Fatal("wire replacement was reused")
			}
		})
	}
}

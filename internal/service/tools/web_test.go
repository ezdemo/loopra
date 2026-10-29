package tools

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebFetchConvertsHTMLAndRejectsBadURLs(t *testing.T) {
	var agents []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agents = append(agents, r.Header.Get("User-Agent"))
		if r.URL.Path == "/challenge" && r.Header.Get("User-Agent") != "opencode" {
			w.Header().Set("Cf-Mitigated", "challenge")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.URL.Path == "/fail" {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if r.URL.Path == "/image" {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{1, 2, 3})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><body><h1>Title</h1><p>Hello <a href="https://example.com/docs">docs</a></p><script>secret</script></body></html>`))
	}))
	defer server.Close()

	markdown, err := fetchWeb(context.Background(), server.URL+"/page", "markdown", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "# Title") || !strings.Contains(markdown, "[docs](https://example.com/docs)") || strings.Contains(markdown, "secret") {
		t.Fatalf("markdown = %s", markdown)
	}
	text, err := fetchWeb(context.Background(), server.URL+"/page", "text", 0)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "secret") || strings.Contains(text, "[docs]") || !strings.Contains(text, "Hello") {
		t.Fatalf("text = %s", text)
	}
	image, err := fetchWeb(context.Background(), server.URL+"/image", "markdown", 0)
	if err != nil || !strings.HasPrefix(image, "data:image/png;base64,") {
		t.Fatalf("image = %s %v", image, err)
	}
	if _, err := fetchWeb(context.Background(), "ftp://example.com", "markdown", 0); err == nil || !strings.Contains(err.Error(), "http://") {
		t.Fatalf("bad url error = %v", err)
	}
	if _, err := fetchWeb(context.Background(), server.URL+"/fail", "html", 0); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("status error = %v", err)
	}
	page, err := fetchWeb(context.Background(), server.URL+"/challenge", "text", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(page, "Title") {
		t.Fatalf("challenge page = %s", page)
	}
	if len(agents) < 2 || agents[len(agents)-1] != "opencode" {
		t.Fatalf("user agents = %v", agents)
	}
}

func TestWebSearchAndCodeSearchUseExaResults(t *testing.T) {
	original := callExa
	t.Cleanup(func() { callExa = original })
	var calls []string
	callExa = func(_ context.Context, endpoint, name string, args map[string]any) (exaResult, error) {
		calls = append(calls, endpoint+" "+name)
		if name == "web_search_exa" && args["numResults"] != 8 {
			t.Fatalf("search args = %v", args)
		}
		if name == "get_code_context_exa" && args["numResults"] != 20 {
			t.Fatalf("code args = %v", args)
		}
		if name == "web_search_exa" {
			return exaResult{}, nil
		}
		return exaResult{text: "react hook"}, nil
	}
	empty, err := runWebSearch(context.Background(), "loopra", 0)
	if err != nil || !strings.Contains(empty, "No search results") {
		t.Fatalf("empty search = %q %v", empty, err)
	}
	code, err := runCodeSearch(context.Background(), "react hooks", 50)
	if err != nil || code != "react hook" {
		t.Fatalf("code = %q %v", code, err)
	}
	callExa = func(context.Context, string, string, map[string]any) (exaResult, error) {
		return exaResult{isError: true}, nil
	}
	if _, err := runCodeSearch(context.Background(), "go", 1); err == nil || !strings.Contains(err.Error(), "Unknown error") {
		t.Fatalf("code error = %v", err)
	}
	callExa = func(context.Context, string, string, map[string]any) (exaResult, error) {
		return exaResult{}, context.DeadlineExceeded
	}
	if _, err := runWebSearch(context.Background(), "go", 1); err == nil || err.Error() != "Search request timed out" {
		t.Fatalf("timeout = %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("calls = %v", calls)
	}
}

func TestWebToolsAreReadOnlyLookups(t *testing.T) {
	names := map[string]bool{}
	for _, entry := range WebTools() {
		names[entry.Meta.Name] = entry.Meta.ReadOnly && entry.Meta.AutoApprove && entry.Tool != nil
	}
	if !names["web"] || len(names) != 1 {
		t.Fatalf("tools = %v", names)
	}
}

func TestWebActionDispatchesSearchFetchAndCode(t *testing.T) {
	original := callExa
	t.Cleanup(func() { callExa = original })
	callExa = func(_ context.Context, endpoint, name string, _ map[string]any) (exaResult, error) {
		return exaResult{text: endpoint + " " + name}, nil
	}
	search, err := runWeb(context.Background(), webInput{Action: "search", Query: "loopra"})
	if err != nil || !strings.Contains(search, "web_search_exa") {
		t.Fatalf("search = %q %v", search, err)
	}
	code, err := runWeb(context.Background(), webInput{Action: "code", Query: "react"})
	if err != nil || !strings.Contains(code, "get_code_context_exa") {
		t.Fatalf("code = %q %v", code, err)
	}
	if _, err := runWeb(context.Background(), webInput{Action: "browse"}); err == nil {
		t.Fatal("unknown action was accepted")
	}
}

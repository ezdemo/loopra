package toolsearch

import (
	"sync"
	"testing"

	"google.golang.org/adk/v2/tool"
)

// AddSource 必须并发安全、拒绝重名，并且 Close 连同后加入的工具集一起关闭。
func TestAddSourceConcurrentAndClose(t *testing.T) {
	set, err := New(nil)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	toolsets := make([]*testToolset, 8)
	for i := range toolsets {
		toolsets[i] = &testToolset{tools: []tool.Tool{fixtureTool(t, "ping", "ping")}, err: nil}
	}
	names := []string{"a", "b", "c", "d", "a", "b", "e", "f"}
	errs := make([]error, len(toolsets))
	for i, ts := range toolsets {
		wg.Add(1)
		go func(i int, ts *testToolset) {
			defer wg.Done()
			errs[i] = set.AddSource(Source{Name: names[i], Toolset: ts})
		}(i, ts)
		// 并发触发惰性加载。
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = set.Search(newTestContext("app", "s"), SearchInput{Query: "ping"})
		}()
	}
	wg.Wait()
	added := map[string]bool{}
	for i, err := range errs {
		if err == nil {
			added[names[i]] = true
		}
	}
	if len(added) != 6 {
		t.Fatalf("expected 6 unique sources added, got %v (errs=%v)", added, errs)
	}
	if err := set.AddSource(Source{Name: "a", Toolset: toolsets[0]}); err == nil {
		t.Fatal("duplicate name must be rejected")
	}
	if err := set.AddSource(Source{Name: "", Toolset: toolsets[0]}); err == nil {
		t.Fatal("empty name must be rejected")
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	for i, ts := range toolsets {
		if errs[i] == nil && ts.closes.Load() != 1 {
			t.Fatalf("added toolset %d not closed", i)
		}
	}
	if err := set.AddSource(Source{Name: "late", Toolset: toolsets[0]}); err == nil {
		t.Fatal("AddSource after Close must fail")
	}
}

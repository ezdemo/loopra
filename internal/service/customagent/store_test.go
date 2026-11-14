package customagent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	home := t.TempDir()
	return New(home), home
}

func TestCreateListUpdateDeleteRoundTrip(t *testing.T) {
	store, _ := newStore(t)
	agent, err := store.Create(Input{Name: "  译员  ", Instruction: "翻译成英文"}, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !IsID(agent.ID) {
		t.Fatalf("id = %q", agent.ID)
	}
	if agent.Name != "译员" || agent.CreatedAt != 1000 || agent.UpdatedAt != 1000 {
		t.Fatalf("agent = %+v", agent)
	}
	if agent.Tools != nil || agent.Skills != nil {
		t.Fatalf("默认应为不限制: %+v", agent)
	}
	list, err := store.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %v %v", list, err)
	}
	updated, err := store.Update(agent.ID, Input{
		Name: "译员2", Instruction: "in2",
		Tools:  []string{" read ", "read", "grep", ""},
		Skills: []string{"@loopra-skills/a", "@loopra-skills/a", " @loopra-skills/b "},
	}, 2000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != agent.ID || updated.CreatedAt != 1000 || updated.UpdatedAt != 2000 {
		t.Fatalf("updated = %+v", updated)
	}
	if len(updated.Tools) != 2 || updated.Tools[0] != "read" || updated.Tools[1] != "rg" {
		t.Fatalf("tools = %v", updated.Tools)
	}
	if len(updated.Skills) != 2 {
		t.Fatalf("skills = %v", updated.Skills)
	}
	if err := store.Delete(agent.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(agent.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete again = %v", err)
	}
	if _, err := store.Update(agent.ID, Input{Name: "x"}, 3000, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update missing = %v", err)
	}
}

func TestNameValidation(t *testing.T) {
	store, _ := newStore(t)
	if _, err := store.Create(Input{Name: "  "}, 1, nil); err == nil {
		t.Fatal("空名称应失败")
	}
	if _, err := store.Create(Input{Name: strings.Repeat("字", 41)}, 1, nil); err == nil {
		t.Fatal("超长名称应失败")
	}
	if _, err := store.Create(Input{Name: "纯聊天"}, 1, nil); err == nil {
		t.Fatal("保留名称应失败")
	}
	first, err := store.Create(Input{Name: "Alpha"}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(Input{Name: "alpha"}, 1, nil); err == nil {
		t.Fatal("大小写不敏感重名应失败")
	}
	if _, err := store.Update(first.ID, Input{Name: "ALPHA"}, 2, nil); err != nil {
		t.Fatalf("改名保持同名大小写应通过: %v", err)
	}
	if _, err := store.Create(Input{Name: "ok", Instruction: strings.Repeat("x", 20001)}, 1, nil); err == nil {
		t.Fatal("超长 instruction 应失败")
	}
}

func TestProjectCheckAndEmptyAllowlist(t *testing.T) {
	store, _ := newStore(t)
	checked := ""
	agent, err := store.Create(Input{Name: "n", ProjectHash: "abc123", Tools: []string{}}, 1, func(hash string) error {
		checked = hash
		return errors.New("项目不存在")
	})
	if err == nil || agent != nil || checked != "abc123" {
		t.Fatalf("check = %v %v %q", agent, err, checked)
	}
	agent, err = store.Create(Input{Name: "n", ProjectHash: "h", Tools: []string{}}, 1, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if agent.Tools == nil || len(agent.Tools) != 0 {
		t.Fatalf("空切片应保持为显式空清单: %v", agent.Tools)
	}
}

func TestCorruptMissingAndReload(t *testing.T) {
	store, home := newStore(t)
	list, err := store.List()
	if err != nil || len(list) != 0 {
		t.Fatalf("missing file = %v %v", list, err)
	}
	agent, err := store.Create(Input{Name: "持久"}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	fresh := New(home)
	got, err := fresh.Get(agent.ID)
	if err != nil || got == nil || got.Name != "持久" {
		t.Fatalf("reload = %+v %v", got, err)
	}
	if err := os.WriteFile(filepath.Join(home, "agents.json"), []byte("{oops"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fresh.List(); !errors.Is(err, ErrStorage) {
		t.Fatalf("corrupt = %v", err)
	}
}

func TestConcurrentCreatesKeepAllUpdates(t *testing.T) {
	store, _ := newStore(t)
	var wg sync.WaitGroup
	const n = 16
	ids := make(chan string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			agent, err := store.Create(Input{Name: strings.Repeat("n", 1+i%3) + string(rune('a'+i))}, 1, nil)
			if err == nil {
				ids <- agent.ID
			}
		}(i)
	}
	wg.Wait()
	close(ids)
	created := map[string]bool{}
	for id := range ids {
		created[id] = true
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != len(created) {
		t.Fatalf("丢失更新: saved=%d created=%d", len(list), len(created))
	}
}

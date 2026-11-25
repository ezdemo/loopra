package shellterm

import "testing"

func TestHubKeyedReuse(t *testing.T) {
	dir := t.TempDir()
	hub := NewHub()
	t.Cleanup(hub.CloseAll)

	first, err := hub.OpenWith(dir, Options{Key: "claude-code\x00new:s1", Agent: "claude-code", Title: "Claude Code"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Agent != "claude-code" || first.Title != "Claude Code" {
		t.Fatalf("agent info = %+v", first)
	}
	again, err := hub.OpenWith(dir, Options{Key: "claude-code\x00new:s1", Agent: "claude-code", Title: "Claude Code"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID {
		t.Fatalf("keyed open spawned %q, want reuse of %q", again.ID, first.ID)
	}
	other, err := hub.OpenWith(dir, Options{Key: "codex\x00new:s1"})
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == first.ID {
		t.Fatal("different key reused the same session")
	}
	// 已退出的会话不再复用：同 key 重新打开应得到新会话。
	if session, ok := hub.Get(first.ID); ok {
		session.Close()
	}
	respawn, err := hub.OpenWith(dir, Options{Key: "claude-code\x00new:s1", Agent: "claude-code"})
	if err != nil {
		t.Fatal(err)
	}
	if respawn.ID == first.ID {
		t.Fatal("exited session reused")
	}
}

func TestHubPlainShellKeepsWorking(t *testing.T) {
	hub := NewHub()
	t.Cleanup(hub.CloseAll)
	info, err := hub.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if info.Agent != "" || info.ID == "" {
		t.Fatalf("plain shell info = %+v", info)
	}
}

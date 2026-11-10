package repository

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAlmaPairingIdentityPersistsAndPreservesUnknownFields(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "alma-relay.json")
	if err := WriteJSON(path, map[string]any{"future": map[string]any{"keep": true}}); err != nil {
		t.Fatal(err)
	}
	first, err := AlmaRelayConfig(home)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AlmaRelayConfig(home)
	if err != nil {
		t.Fatal(err)
	}
	if first["connectCode"] != second["connectCode"] || first["connectCode"] == "" || second["future"] == nil {
		t.Fatal(first, second)
	}
	if err := os.WriteFile(path, []byte("broken-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := AlmaRelayConfig(home); err == nil {
		t.Fatal("corrupt pairing silently replaced")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "broken-json" {
		t.Fatal("corrupt config overwritten")
	}
}

package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testCatalog() Catalog {
	return Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "tok", Name: "测试", Category: "dev",
			Transport: Transport{Type: "streamable", URL: "https://x/mcp?key={{key}}"},
			Auth:      Auth{Type: "token", Fields: []Field{{Key: "key", Secret: true}}},
		}},
	}
}

func writeEntry(t *testing.T, path string, entries string, topExtra string) {
	t.Helper()
	body := `{"connectors": {` + entries + `}` + topExtra + `}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestStoreFileMode0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix file mode")
	}
	dir := t.TempDir()
	s := New(testCatalog(), dir)
	if err := s.mutate(func() error {
		s.entries["tok"] = &entry{Enabled: true, Status: StatusConnected, Fields: map[string]string{"key": "v"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "connectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode = %o, want 600", perm)
	}
}

func TestStorePreservesUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "connectors.json")
	writeEntry(t, path,
		`"tok": {"enabled": true, "status": "connected", "fields": {"key": "v1"}, "future": {"keep": 1}}`,
		`,"topFuture": [1,2]`)
	s := New(testCatalog(), dir)
	if err := s.Toggle("tok", false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]json.RawMessage
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	var topFuture []int
	if err := json.Unmarshal(file["topFuture"], &topFuture); err != nil || len(topFuture) != 2 {
		t.Fatalf("top-level unknown field lost: %s", raw)
	}
	var conns map[string]map[string]json.RawMessage
	if err := json.Unmarshal(file["connectors"], &conns); err != nil {
		t.Fatal(err)
	}
	e := conns["tok"]
	var future map[string]int
	if err := json.Unmarshal(e["future"], &future); err != nil || future["keep"] != 1 {
		t.Fatalf("entry unknown field lost: %v", e)
	}
	if string(e["enabled"]) != "false" {
		t.Fatalf("toggle not persisted: %s", e["enabled"])
	}
}

func TestViewNeverExposesSecrets(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "connectors.json")
	writeEntry(t, path,
		`"tok": {"enabled": true, "status": "connected", "fields": {"key": "supersecret"}, "oauth": {"clientId": "c", "authUrl": "a", "tokenUrl": "t", "authStyle": 0, "token": {"access_token": "at"}}}`,
		``)
	s := New(testCatalog(), dir)
	view := s.View("tok")
	data, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"supersecret", "at"} {
		if strings.Contains(string(data), `"`+secret+`"`) {
			t.Fatalf("view leaks secret: %s", data)
		}
	}
	if len(view.ConfiguredFields) != 1 || view.ConfiguredFields[0] != "key" {
		t.Fatalf("configuredFields = %v", view.ConfiguredFields)
	}
}

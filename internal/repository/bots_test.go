package repository

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/model"
)

func TestBotsPreserveUnknownFieldsAndLoadErrors(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "bots.json")
	r := NewBotRepository(home)
	if records, err := r.Load(); err != nil || len(records) != 0 {
		t.Fatalf("new installation = %v %v", records, err)
	}
	raw := []byte(`{"future":{"enabled":true},"bots":[{"id":"one","name":"Bot","appSecret":"test-only","newSetting":{"value":3}}]}`)
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	records, err := r.Load()
	if err != nil {
		t.Fatal(err)
	}
	records[0].Name = "Renamed"
	if err := r.Save(records); err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	data, _ := os.ReadFile(file)
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	b := saved["bots"].([]any)[0].(map[string]any)
	if saved["future"] == nil || b["newSetting"] == nil || b["name"] != "Renamed" || b["appSecret"] != "test-only" {
		t.Fatalf("lost fields: %s", data)
	}
	for _, corrupt := range []string{"{", "null", `{"bots":null}`, `{"bots":{}}`} {
		if err := os.WriteFile(file, []byte(corrupt), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Load(); err == nil {
			t.Fatalf("accepted corrupt configuration: %s", corrupt)
		}
		if err := r.Save([]model.Bot{}); err == nil {
			t.Fatalf("overwrote corrupt configuration: %s", corrupt)
		}
	}
	if err := os.WriteFile(file, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.Save([]model.Bot{}); err == nil {
		t.Fatal("save overwrote corrupt file")
	}
	data, _ = os.ReadFile(file)
	if strings.TrimSpace(string(data)) != "{" {
		t.Fatal("corrupt data was replaced")
	}
}

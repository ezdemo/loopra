package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
)

func TestJavaLegacyConfigPricesAndBooleanHitl(t *testing.T) {
	home := t.TempDir()
	fixture := []byte(`{"baseUrl":"https://example.invalid/v1","apiKey":"fixture-key","model":"mock","hitl":true,"price":{"mock":{"input":"1.5","cache":"0.25","output":"3"}},"future":{"retained":true}}`)
	if err := os.WriteFile(filepath.Join(home, "config.json"), fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := repository.NewConfigRepository(home).Load()
	if err != nil {
		t.Fatal(err)
	}
	channel, ok := cfg.ChannelByID("")
	if !ok || channel.APIKey != "fixture-key" || channel.BaseURL != "https://example.invalid/v1" {
		t.Fatal("legacy channel settings were not migrated")
	}
	if cfg.Hitl != "approval" || cfg.Price["mock"].Input != 1.5 || cfg.Price["mock"].Cache != 0.25 {
		t.Fatalf("legacy values = %q %v", cfg.Hitl, cfg.Price)
	}
	if err := repository.NewConfigRepository(home).Save(cfg); err != nil {
		t.Fatal(err)
	}
	saved, err := repository.NewConfigRepository(home).Load()
	if err != nil {
		t.Fatal(err)
	}
	var future map[string]bool
	if json.Unmarshal(saved.Extra["future"], &future) != nil || !future["retained"] {
		t.Fatal("unknown configuration was dropped")
	}
}

func TestJavaStringModelEntries(t *testing.T) {
	cfg := config.Default()
	if err := json.Unmarshal([]byte(`{"modelChannels":[{"id":"legacy","models":["first",{"name":"second"}]}]}`), &cfg); err != nil {
		t.Fatal(err)
	}
	for _, model := range cfg.ModelChannels[0].Models {
		if model.ContextTokens != -1 || model.MaxTokens != -1 {
			t.Fatalf("missing model limits = %+v", model)
		}
	}
}

func TestToolModelConfigMigration(t *testing.T) {
	cases := []struct {
		name      string
		payload   string
		model     string
		channelID string
	}{
		{"legacy pair fills empty tool model", `{"toolModel":"","toolModelChannelId":"","validationModel":"review","validationModelChannelId":"legacy","future":true}`, "review", "legacy"},
		{"tool model wins over legacy", `{"toolModel":"helper","toolModelChannelId":"new","validationModel":"review","validationModelChannelId":"legacy","future":true}`, "helper", "new"},
		{"legacy model without channel stays empty", `{"validationModel":"review","future":true}`, "", ""},
		{"tool model without channel pins current channel", `{"toolModel":"helper","modelChannelId":"active","modelChannels":[{"id":"active","models":["helper"]}],"future":true}`, "helper", "active"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := config.Default()
			if err := json.Unmarshal([]byte(tc.payload), &cfg); err != nil {
				t.Fatal(err)
			}
			if cfg.ToolModel != tc.model || cfg.ToolModelChannelID != tc.channelID {
				t.Fatalf("tool model = %q/%q, want %q/%q", cfg.ToolModel, cfg.ToolModelChannelID, tc.model, tc.channelID)
			}
			raw, err := json.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			var saved map[string]any
			if err := json.Unmarshal(raw, &saved); err != nil {
				t.Fatal(err)
			}
			if _, ok := saved["validationModel"]; ok {
				t.Fatal("legacy validationModel key was persisted")
			}
			if _, ok := saved["validationModelChannelId"]; ok {
				t.Fatal("legacy validationModelChannelId key was persisted")
			}
			if saved["future"] != true {
				t.Fatal("unknown configuration was dropped")
			}
			var roundtrip config.Loopra
			if err := json.Unmarshal(raw, &roundtrip); err != nil {
				t.Fatal(err)
			}
			if roundtrip.ToolModel != tc.model || roundtrip.ToolModelChannelID != tc.channelID {
				t.Fatalf("round-trip tool model = %q/%q, want %q/%q", roundtrip.ToolModel, roundtrip.ToolModelChannelID, tc.model, tc.channelID)
			}
		})
	}
}

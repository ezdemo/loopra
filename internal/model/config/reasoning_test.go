package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
)

func TestModelReasoningEffortsNilVersusEmpty(t *testing.T) {
	var entry config.ModelEntry
	if err := json.Unmarshal([]byte(`"legacy-model"`), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ReasoningEfforts != nil {
		t.Fatalf("legacy string entry levels = %v", entry.ReasoningEfforts)
	}
	if err := json.Unmarshal([]byte(`{"name":"plain"}`), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ReasoningEfforts != nil {
		t.Fatalf("missing levels = %v", entry.ReasoningEfforts)
	}
	data, _ := json.Marshal(entry)
	if strings.Contains(string(data), "reasoningEfforts") {
		t.Fatalf("nil levels should be omitted: %s", data)
	}
	if err := json.Unmarshal([]byte(`{"name":"quiet","reasoningEfforts":[]}`), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ReasoningEfforts == nil || len(entry.ReasoningEfforts) != 0 {
		t.Fatalf("explicit empty = %v", entry.ReasoningEfforts)
	}
	data, _ = json.Marshal(entry)
	if !strings.Contains(string(data), `"reasoningEfforts":[]`) {
		t.Fatalf("explicit empty should persist: %s", data)
	}
}

// 配置值去空白、去重、保持大小写与顺序；"default" 是 Fusion 的
// 保留取值，载入即拒绝。
func TestModelReasoningEffortsNormalization(t *testing.T) {
	var entry config.ModelEntry
	if err := json.Unmarshal([]byte(`{"name":"m","reasoningEfforts":[" low ","Turbo","low","","MAX","Turbo"]}`), &entry); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(entry.ReasoningEfforts, []string{"low", "Turbo", "MAX"}) {
		t.Fatalf("normalized = %v", entry.ReasoningEfforts)
	}
	if err := json.Unmarshal([]byte(`{"name":"m","reasoningEfforts":["default"]}`), &entry); err == nil {
		t.Fatal("reserved default accepted")
	}
}

func TestReasoningEffortsPersistRoundTrip(t *testing.T) {
	home := t.TempDir()
	cfg := config.Default()
	cfg.ModelChannels[0].Models[0].ReasoningEfforts = []string{"minimal", "high"}
	cfg.ModelChannels[0].Models = append(cfg.ModelChannels[0].Models, config.ModelEntry{Name: "silent", ReasoningEfforts: []string{}})
	if err := repository.NewConfigRepository(home).Save(&cfg); err != nil {
		t.Fatal(err)
	}
	saved, err := repository.NewConfigRepository(home).Load()
	if err != nil {
		t.Fatal(err)
	}
	first := saved.ModelChannels[0].Models[0].ReasoningEfforts
	if !slices.Equal(first, []string{"minimal", "high"}) {
		t.Fatalf("round trip = %v", first)
	}
	if saved.ModelChannels[0].Models[1].ReasoningEfforts == nil {
		t.Fatal("explicit empty list lost")
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	channels := file["modelChannels"].([]any)
	models := channels[0].(map[string]any)["models"].([]any)
	if _, kept := models[0].(map[string]any)["reasoningEfforts"]; !kept {
		t.Fatal("configured levels not persisted")
	}
	if levels, kept := models[1].(map[string]any)["reasoningEfforts"].([]any); !kept || len(levels) != 0 {
		t.Fatalf("file does not persist []: %v", models[1])
	}
}

// ReasoningEffortsFor 按精确（渠道, 模型）解析；同名模型在不同渠道
// 各自独立，命名模型缺失不借用其他条目，空模型名取首个条目。
func TestReasoningEffortsFor(t *testing.T) {
	cfg := config.Default()
	cfg.ModelChannels = []config.Channel{
		{ID: "a", Models: []config.ModelEntry{
			{Name: "shared", ReasoningEfforts: []string{"low"}},
			{Name: "other", ReasoningEfforts: []string{"high"}},
		}},
		{ID: "b", Models: []config.ModelEntry{
			{Name: "shared", ReasoningEfforts: []string{"max"}},
		}},
	}
	if got := cfg.ReasoningEffortsFor("a", "shared"); !slices.Equal(got, []string{"low"}) {
		t.Fatalf("channel a = %v", got)
	}
	if got := cfg.ReasoningEffortsFor("b", "shared"); !slices.Equal(got, []string{"max"}) {
		t.Fatalf("channel b = %v", got)
	}
	if got := cfg.ReasoningEffortsFor("a", ""); !slices.Equal(got, []string{"low"}) {
		t.Fatalf("first entry = %v", got)
	}
	if got := cfg.ReasoningEffortsFor("a", "missing"); got != nil {
		t.Fatalf("missing model borrowed levels: %v", got)
	}
	if got := cfg.ReasoningEffortsFor("missing", "shared"); got != nil {
		t.Fatalf("missing channel = %v", got)
	}
}

func TestResolveReasoningEffort(t *testing.T) {
	if got := config.ResolveReasoningEffort(nil, "Turbo", "high"); got != "Turbo" {
		t.Fatalf("legacy passthrough = %q", got)
	}
	if got := config.ResolveReasoningEffort(nil, "", "high"); got != "high" {
		t.Fatalf("legacy fallback = %q", got)
	}
	levels := []string{"minimal", "high"}
	if got := config.ResolveReasoningEffort(levels, "high", "low"); got != "high" {
		t.Fatalf("supported preferred = %q", got)
	}
	if got := config.ResolveReasoningEffort(levels, "xhigh", "high"); got != "high" {
		t.Fatalf("fallback inside list = %q", got)
	}
	if got := config.ResolveReasoningEffort(levels, "xhigh", "max"); got != "minimal" {
		t.Fatalf("first configured = %q", got)
	}
	if got := config.ResolveReasoningEffort([]string{}, "high", "high"); got != "" {
		t.Fatalf("explicit empty = %q", got)
	}
}

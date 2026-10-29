package acpserver

import (
	"testing"

	modelconfig "github.com/ezdemo/looprax/internal/model/config"
)

func TestContextWindowUsesConfiguredModel(t *testing.T) {
	cfg := modelconfig.Default()
	cfg.Model = "deepseek-v4.1-flash"
	cfg.ModelChannelID = "openai"
	cfg.ModelChannels = []modelconfig.Channel{{
		ID: "openai", Name: "Open Design",
		Models: []modelconfig.ModelEntry{{Name: "deepseek-v4.1-flash", ContextTokens: 128000, MaxTokens: 8192}},
	}}
	session := &liveSession{model: cfg.Model, channel: cfg.ModelChannelID, cfg: &cfg}
	if session.contextWindow() != 128000 {
		t.Fatalf("window = %d", session.contextWindow())
	}
	session.model = "missing"
	if session.contextWindow() != 0 {
		t.Fatal("unknown model should not invent a window")
	}
}

func TestFingerprintMatchesForkPoint(t *testing.T) {
	text := "你好哈哈！我在呢"
	got := fingerprintOf(text)
	if len(got) != len("sha256:")+64 || got[:7] != "sha256:" {
		t.Fatalf("fingerprint = %q", got)
	}
	meta := map[string]any{
		"jetbrains": map[string]any{"air": map[string]any{"fork": map[string]any{
			"messageFingerprint": got,
			"messageOccurrence":  float64(1),
		}}},
	}
	fingerprint, occurrence, ok := forkPoint(meta)
	if !ok || fingerprint != got || occurrence != 1 {
		t.Fatalf("point = %q %d %v", fingerprint, occurrence, ok)
	}
}

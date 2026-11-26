package acp

import (
	"path/filepath"
	"testing"
)

func TestRunTurnSendsDisplayConventionOncePerRemote(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	host := &seedHost{reuseHost: reuseHost{app: "app", workspace: t.TempDir()}}
	conn := seedConn(t, host.workspace, map[string]string{
		"LOOPRA_ACP_FAKE_PROMPT_LOG":             log,
		"LOOPRA_ACP_FAKE_LOG_DISPLAY_CONVENTION": "1",
	})
	host.SetMeta("s", map[string]any{"agentId": "codex"})
	manager := seedManager(t, host, conn)
	sink := &recordSink{}

	seedTurn(t, manager, host, conn, sink, "第一句")
	if len(sink.failures) != 0 {
		t.Fatalf("first failures = %v", sink.failures)
	}
	prompts := promptLog(t, log)
	if len(prompts) != 1 || prompts[0] != "第一句\n[display-convention]" {
		t.Fatalf("first prompt = %#v", prompts)
	}
	if got := host.Meta("s")["acpDisplayConventionSessionId"]; got != "fake-session" {
		t.Fatalf("display convention marker = %#v", got)
	}

	seedTurn(t, manager, host, conn, sink, "第二句")
	prompts = promptLog(t, log)
	if len(prompts) != 2 || prompts[1] != "第二句" {
		t.Fatalf("second prompt repeated display convention: %#v", prompts)
	}

	conn.acpSession = "session-new"
	seedTurn(t, manager, host, conn, sink, "换远端")
	prompts = promptLog(t, log)
	if len(prompts) != 3 || prompts[2] != "换远端\n[display-convention]" {
		t.Fatalf("new remote prompt = %#v", prompts)
	}
	if got := host.Meta("s")["acpDisplayConventionSessionId"]; got != "session-new" {
		t.Fatalf("display convention marker after new remote = %#v", got)
	}
}

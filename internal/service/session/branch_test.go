package session

import (
	"os"
	"path/filepath"
	"testing"
)

// 跨引擎 .meta 剥离源引擎的执行状态、模型选择与角色绑定，
// 未列出的键（连接器开关、自定义扩展）原样保留。
func TestConvertedBranchMetaDropsEngineStateKeepsUnknownKeys(t *testing.T) {
	source := map[string]any{
		"agentId":                   "codex",
		"title":                     "旧标题",
		"model":                     "gpt-x",
		"modelChannelId":            "ch-1",
		"reasoningEffort":           "high",
		"customAgentId":             "agent-1",
		"agentConfig":               map[string]any{"mode": "yolo"},
		"hitl":                      true,
		"acpSessionId":              "remote-1",
		"acpCwd":                    "/tmp/x",
		"acpUsage":                  map[string]any{"used": 1},
		"acpPlan":                   []any{"step"},
		"acpCommands":               map[string]any{"cmd": true},
		"acpHistorySeed":            true,
		"acpHistorySeededSessionId": "remote-1",
		"worktreeMode":              true,
		"connectors":                map[string]any{"web": true},
		"futureExtension":           "keep",
	}
	meta := ConvertedBranchMeta(source, "claude-code", "[分支]新标题")
	for _, key := range []string{"model", "modelChannelId", "reasoningEffort", "customAgentId", "agentConfig", "hitl",
		"acpSessionId", "acpCwd", "acpUsage", "acpPlan", "acpCommands", "acpHistorySeededSessionId"} {
		if _, ok := meta[key]; ok {
			t.Fatalf("converted meta kept %s", key)
		}
	}
	if meta["agentId"] != "claude-code" || meta["title"] != "[分支]新标题" || meta["worktreeMode"] != false {
		t.Fatalf("meta = %#v", meta)
	}
	if meta["acpHistorySeed"] != true {
		t.Fatalf("external target missing seed marker: %#v", meta)
	}
	if meta["connectors"].(map[string]any)["web"] != true || meta["futureExtension"] != "keep" {
		t.Fatalf("unknown keys lost: %#v", meta)
	}
	// 源 .meta 不能被改动。
	if source["agentId"] != "codex" || source["title"] != "旧标题" {
		t.Fatal("source meta mutated")
	}
}

func TestConvertedBranchMetaNativeTargetDoesNotSeed(t *testing.T) {
	meta := ConvertedBranchMeta(map[string]any{"acpSessionId": "r", "customAgentId": "a"}, "native", "[分支]t")
	if _, ok := meta["acpHistorySeed"]; ok {
		t.Fatalf("native target got seed marker: %#v", meta)
	}
}

// ReadMessages 与 Messages 读取同一份可见历史，但把读文件错误透给调用方，
// 让依赖完整历史的写路径能中止而不是按空历史继续。
func TestReadMessagesPropagatesReadFailure(t *testing.T) {
	store := Open(t.TempDir(), "app")
	rows, err := store.ReadMessages("missing")
	if err != nil || len(rows) != 0 {
		t.Fatalf("missing log: rows=%#v err=%v", rows, err)
	}
	dir := store.LogPath("broken")
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadMessages("broken"); err == nil {
		t.Fatal("unreadable log was silently treated as empty history")
	}
}

func TestReadMessagesFiltersLikeMessages(t *testing.T) {
	store := Open(t.TempDir(), "app")
	if err := os.MkdirAll(filepath.Dir(store.LogPath("s")), 0o755); err != nil {
		t.Fatal(err)
	}
	raw := []byte("{\"role\":\"user\",\"content\":\"hi\",\"adk_event\":\"blob\"}\n" +
		"{\"role\":\"assistant\",\"content\":\"hidden\",\"web_hidden\":true}\n" +
		"{\"noRole\":true}\n" +
		"not-json\n")
	if err := os.WriteFile(store.LogPath("s"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	rows, err := store.ReadMessages("s")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["content"] != "hi" || rows[0]["adk_event"] != nil {
		t.Fatalf("rows = %#v", rows)
	}
}

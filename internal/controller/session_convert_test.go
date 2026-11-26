package controller

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/service/acp"
)

// stubConvertProviders 让所有外部引擎可解析、但任何拉起进程的尝试都失败：
// 跨引擎分支两侧的适配器都不该被触碰。
func stubConvertProviders(t *testing.T) {
	t.Helper()
	previous := acp.Providers
	acp.Providers = nil
	for _, id := range []string{"codex", "claude-code", "devin"} {
		acp.Providers = append(acp.Providers, acp.Provider{
			ID:   id,
			Name: id,
			Prepare: func(string) (acp.Launch, error) {
				return acp.Launch{}, errors.New("unexpected process start")
			},
		})
	}
	t.Cleanup(func() { acp.Providers = previous })
}

func seedConvertSource(t *testing.T, s *Controller, name, agentID string, rows []map[string]any) {
	t.Helper()
	ctx := contextBG()
	if _, err := s.agent.Sessions.Create(ctx, createReq(s.agent, name)); err != nil {
		t.Fatal(err)
	}
	if err := s.agent.Sessions.AppendTranscript(s.agent.App(), name, rows); err != nil {
		t.Fatal(err)
	}
	if agentID != "" {
		s.sessionMetaSet(name, map[string]any{"agentId": agentID})
	}
}

var convertRows = []map[string]any{
	{"role": "user", "content": "first question"},
	{"role": "assistant", "content": "first answer"},
	{"role": "user", "content": "later question"},
	{"role": "assistant", "content": "later answer"},
}

// 每个有序的源/目标组合都复制本地可见转录前缀：进程不启动，源不动。
func TestSessionConvertAcrossEngines(t *testing.T) {
	stubConvertProviders(t)
	engines := []string{"native", "codex", "claude-code", "devin"}
	for _, sourceID := range engines {
		for _, targetID := range engines {
			if sourceID == targetID {
				continue
			}
			t.Run(sourceID+"-to-"+targetID, func(t *testing.T) {
				ts, key, s, _ := parityServer(t, "")
				const name = "src"
				seedConvertSource(t, s, name, sourceID, convertRows)
				s.sessionMetaSet(name, map[string]any{
					"title": "Original", "acpSessionId": "remote-old", "model": "m",
					"customAgentId": "agent-x", "connectors": map[string]any{"web": true},
				})
				code, env := call(t, ts, http.MethodPost,
					"/api/sessions/"+name+"/branch?messageCount=2&agentId="+targetID, key, nil)
				if code != http.StatusOK {
					t.Fatalf("branch = %d %v", code, env)
				}
				data := env["data"].(map[string]any)
				if data["agentId"] != targetID {
					t.Fatalf("response agentId = %v", data["agentId"])
				}
				newName, _ := data["sessionName"].(string)
				if newName == "" || newName == name {
					t.Fatalf("sessionName = %q", newName)
				}
				meta := s.sessionMetaRead(newName)
				if meta["agentId"] != targetID || meta["title"] != "[复刻]Original" {
					t.Fatalf("meta = %#v", meta)
				}
				for _, leaked := range []string{"acpSessionId", "acpCwd", "model", "customAgentId", "agentConfig", "acpHistorySeededSessionId"} {
					if _, ok := meta[leaked]; ok {
						t.Fatalf("source state leaked into converted meta: %s in %#v", leaked, meta)
					}
				}
				if meta["connectors"].(map[string]any)["web"] != true {
					t.Fatalf("unknown keys lost: %#v", meta)
				}
				if targetID == "native" {
					if _, ok := meta["acpHistorySeed"]; ok {
						t.Fatalf("native target got seed marker: %#v", meta)
					}
				} else if meta["acpHistorySeed"] != true {
					t.Fatalf("external target missing seed marker: %#v", meta)
				}
				got := sessionMessagesOf(t, s.agent, newName)
				if len(got) != 2 || got[0]["content"] != "first question" || got[1]["content"] != "first answer" {
					t.Fatalf("copied prefix = %#v", got)
				}
				// .events 也只写前缀行，不带后续历史。
				dir := filepath.Join(s.agent.Sessions.Root(), "workspace", s.agent.App(), "sessions")
				if raw, err := os.ReadFile(filepath.Join(dir, newName+".events")); err != nil {
					t.Fatalf("events mirror missing: %v", err)
				} else if lines := len(decodeJSONLines(raw)); lines != 2 {
					t.Fatalf("events lines = %d, want 2", lines)
				}
				source := s.sessionMetaRead(name)
				if source["acpSessionId"] != "remote-old" || source["customAgentId"] != "agent-x" ||
					len(sessionMessagesOf(t, s.agent, name)) != 4 {
					t.Fatal("source mutated by cross-engine branch")
				}
			})
		}
	}
}

// 外部源没有远端 id、也不在进程中时，仍能按整段历史转到其他引擎。
func TestSessionConvertForkCopiesWholeHistoryWithoutRemote(t *testing.T) {
	stubConvertProviders(t)
	ts, key, s, _ := parityServer(t, "")
	seedConvertSource(t, s, "src", "codex", convertRows)
	code, env := call(t, ts, http.MethodPost, "/api/sessions/src/fork?agentId=native", key, nil)
	if code != http.StatusOK {
		t.Fatalf("fork = %d %v", code, env)
	}
	data := env["data"].(map[string]any)
	if data["agentId"] != "native" {
		t.Fatalf("agentId = %v", data["agentId"])
	}
	newName, _ := data["sessionName"].(string)
	meta := s.sessionMetaRead(newName)
	if meta["agentId"] != "native" || meta["title"] != "[分支]src" {
		t.Fatalf("meta = %#v", meta)
	}
	if got := len(sessionMessagesOf(t, s.agent, newName)); got != 4 {
		t.Fatalf("whole history rows = %d, want 4", got)
	}
}

// 同引擎的既有语义不变：native 分支照旧，外部 fork 仍要求远端记录。
func TestSessionSameEnginePathsUnchanged(t *testing.T) {
	stubConvertProviders(t)
	ts, key, s, _ := parityServer(t, "")
	seedConvertSource(t, s, "ext", "codex", convertRows)
	// 外部源未建远端：同引擎 fork 走旧路径并拒绝。
	code, env := call(t, ts, http.MethodPost, "/api/sessions/ext/fork?agentId=codex", key, nil)
	if code != http.StatusBadRequest || env["error"] != "源会话尚未建立远端记录，无法创建分叉" {
		t.Fatalf("same-engine fork = %d %v", code, env)
	}
	seedConvertSource(t, s, "nat", "", convertRows)
	code, env = call(t, ts, http.MethodPost, "/api/sessions/nat/fork?agentId=native", key, nil)
	if code != http.StatusBadRequest || env["error"] != "当前会话不支持 ACP 分叉" {
		t.Fatalf("native fork = %d %v", code, env)
	}
	// looprax 归一化为 native：native 源同引擎 → 旧分支语义。
	code, env = call(t, ts, http.MethodPost, "/api/sessions/nat/branch?messageCount=2&agentId=looprax", key, nil)
	if code != http.StatusOK {
		t.Fatalf("looprax alias branch = %d %v", code, env)
	}
	if got := env["data"].(map[string]any)["agentId"]; got != "native" {
		t.Fatalf("looprax normalized to %v", got)
	}
}

func TestSessionConvertRejectsBadTargetsAndCounts(t *testing.T) {
	stubConvertProviders(t)
	ts, key, s, _ := parityServer(t, "")
	seedConvertSource(t, s, "src", "codex", convertRows)
	reject := func(path string, want string) {
		t.Helper()
		code, env := call(t, ts, http.MethodPost, path, key, nil)
		if code != http.StatusBadRequest || env["error"] != want {
			t.Fatalf("%s = %d %v", path, code, env)
		}
	}
	reject("/api/sessions/src/branch?messageCount=2&agentId=bogus", "Agent 引擎不可用: bogus")
	reject("/api/sessions/src/branch?messageCount=9&agentId=native", "messageCount 超过会话消息数")
	reject("/api/sessions/src/branch?messageCount=1&agentId=native", "请选择一条完整回复作为分叉位置")
	reject("/api/sessions/src/branch?messageCount=0&agentId=native", "messageCount 必须为正整数")
	reject("/api/sessions/src/branch?agentId=native", "messageCount 必须为正整数")
	reject("/api/sessions/missing/branch?messageCount=2&agentId=native", "会话不存在: missing")
	if names := sessionNames(t, ts, key); len(names) != 1 || names[0] != "src" {
		t.Fatalf("failed requests created sessions: %v", names)
	}
}

// 纯聊天与智能体工作区不允许把会话转换到外部引擎。
func TestSessionConvertRejectsExternalInChatAndAgentWorkspaces(t *testing.T) {
	stubConvertProviders(t)
	ts, key, _, _ := parityServer(t, "")
	code, env := call(t, ts, http.MethodPost,
		"/api/sessions/any/branch?workspaceHash="+chatWorkspace+"&messageCount=1&agentId=codex", key, nil)
	if code != http.StatusBadRequest || env["error"] != "当前工作区不支持外部 Agent" {
		t.Fatalf("chat workspace = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodPost,
		"/api/sessions/any/fork?workspaceHash="+chatWorkspace+"&agentId=devin", key, nil)
	if code != http.StatusBadRequest || env["error"] != "当前工作区不支持外部 Agent" {
		t.Fatalf("chat fork = %d %v", code, env)
	}
	code, env = postAgent(t, ts, key, map[string]any{"name": "译员", "instruction": "翻译"})
	if code != http.StatusOK {
		t.Fatal(env)
	}
	agentID := env["data"].(map[string]any)["id"].(string)
	code, env = call(t, ts, http.MethodPost,
		"/api/sessions/any/fork?workspaceHash="+agentID+"&agentId=codex", key, nil)
	if code != http.StatusBadRequest || env["error"] != "当前工作区不支持外部 Agent" {
		t.Fatalf("agent workspace = %d %v", code, env)
	}
}

// 转到 native 的分支能经 ADK 回放：工具调用、工具结果与多模态内容原样落盘。
func TestSessionConvertToNativeReplaysToolsAndImages(t *testing.T) {
	stubConvertProviders(t)
	ts, key, s, _ := parityServer(t, "")
	rows := []map[string]any{
		{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "看这张图"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AAAA"}},
		}},
		{"role": "assistant", "tool_calls": []any{
			map[string]any{"id": "call-1", "type": "function",
				"function": map[string]any{"name": "Read", "arguments": `{"path":"a.txt"}`}},
		}},
		{"role": "tool", "tool_call_id": "call-1", "tool_name": "Read", "content": "file body"},
		{"role": "assistant", "content": "读完了"},
	}
	seedConvertSource(t, s, "src", "codex", rows)
	code, env := call(t, ts, http.MethodPost, "/api/sessions/src/fork?agentId=native", key, nil)
	if code != http.StatusOK {
		t.Fatalf("fork = %d %v", code, env)
	}
	newName := env["data"].(map[string]any)["sessionName"].(string)
	got, err := s.agent.Sessions.Get(contextBG(), getSessionRequest(s.agent, newName))
	if err != nil {
		t.Fatal(err)
	}
	var haveImage, haveCall, haveResponse bool
	events := got.Session.Events()
	for i := 0; i < events.Len(); i++ {
		event := events.At(i)
		for _, content := range []*genai.Content{event.Content, event.LLMResponse.Content} {
			if content == nil {
				continue
			}
			for _, part := range content.Parts {
				switch {
				case part.InlineData != nil:
					haveImage = true
				case part.FunctionCall != nil:
					haveCall = true
				case part.FunctionResponse != nil:
					haveResponse = true
				}
			}
		}
	}
	if !haveImage || !haveCall || !haveResponse {
		t.Fatalf("replayed events lost parts: image=%v call=%v response=%v", haveImage, haveCall, haveResponse)
	}
}

// 待注入历史的会话同引擎分叉也走本地复刻：注入的回复只存在于提示词里，
// 远端按指纹分叉找不到它们。复刻保留模型与配置，但拿到全新远端身份。
func TestSessionSeededSameEngineBranchCopiesLocally(t *testing.T) {
	stubConvertProviders(t)

	assertLocalCopy := func(t *testing.T, s *Controller, source, newName string, wantTitle string, rows int) {
		t.Helper()
		meta := s.sessionMetaRead(newName)
		if meta["agentId"] != "codex" || meta["title"] != wantTitle || meta["worktreeMode"] != false {
			t.Fatalf("meta = %#v", meta)
		}
		if meta["model"] != "m1" || meta["agentConfig"].(map[string]any)["mode"] != "yolo" {
			t.Fatalf("model/config not inherited: %#v", meta)
		}
		if meta["acpHistorySeed"] != true {
			t.Fatalf("seed flag lost: %#v", meta)
		}
		for _, leaked := range []string{"acpSessionId", "acpHistorySeededSessionId"} {
			if _, ok := meta[leaked]; ok {
				t.Fatalf("remote identity leaked: %s in %#v", leaked, meta)
			}
		}
		if got := sessionMessagesOf(t, s.agent, newName); len(got) != rows {
			t.Fatalf("copied rows = %d, want %d", len(got), rows)
		}
		if len(sessionMessagesOf(t, s.agent, source)) != 4 ||
			s.sessionMetaRead(source)["acpHistorySeed"] != true {
			t.Fatal("source mutated by local copy")
		}
	}

	t.Run("no-remote-yet-branch", func(t *testing.T) {
		ts, key, s, _ := parityServer(t, "")
		seedConvertSource(t, s, "src", "codex", convertRows)
		s.sessionMetaSet("src", map[string]any{
			"title": "Imported", "model": "m1",
			"agentConfig": map[string]any{"mode": "yolo"}, "acpHistorySeed": true,
		})
		code, env := call(t, ts, http.MethodPost,
			"/api/sessions/src/branch?messageCount=2&agentId=codex", key, nil)
		if code != http.StatusOK {
			t.Fatalf("branch = %d %v", code, env)
		}
		assertLocalCopy(t, s, "src", env["data"].(map[string]any)["sessionName"].(string), "[复刻]Imported", 2)
	})

	t.Run("no-remote-yet-fork-prefix", func(t *testing.T) {
		ts, key, s, _ := parityServer(t, "")
		seedConvertSource(t, s, "src", "codex", convertRows)
		s.sessionMetaSet("src", map[string]any{
			"title": "Imported", "model": "m1",
			"agentConfig": map[string]any{"mode": "yolo"}, "acpHistorySeed": true,
		})
		code, env := call(t, ts, http.MethodPost,
			"/api/sessions/src/fork?messageCount=2&agentId=codex", key, nil)
		if code != http.StatusOK {
			t.Fatalf("fork = %d %v", code, env)
		}
		assertLocalCopy(t, s, "src", env["data"].(map[string]any)["sessionName"].(string), "[复刻]Imported", 2)
	})

	t.Run("seeded-remote-fork-full", func(t *testing.T) {
		ts, key, s, _ := parityServer(t, "")
		seedConvertSource(t, s, "src", "codex", convertRows)
		s.sessionMetaSet("src", map[string]any{
			"title": "Imported", "model": "m1",
			"agentConfig": map[string]any{"mode": "yolo"}, "acpHistorySeed": true,
			"acpSessionId": "remote-seeded", "acpHistorySeededSessionId": "remote-seeded",
		})
		code, env := call(t, ts, http.MethodPost, "/api/sessions/src/fork?agentId=codex", key, nil)
		if code != http.StatusOK {
			t.Fatalf("fork = %d %v", code, env)
		}
		assertLocalCopy(t, s, "src", env["data"].(map[string]any)["sessionName"].(string), "[分支]Imported", 4)
	})

	// 没有注入标记的同引擎会话照旧走远端分叉：远端 id 存在时仍要求适配器。
	t.Run("no-seed-still-remote", func(t *testing.T) {
		ts, key, s, _ := parityServer(t, "")
		seedConvertSource(t, s, "src", "codex", convertRows)
		s.sessionMetaSet("src", map[string]any{"acpSessionId": "remote-1"})
		code, _ := call(t, ts, http.MethodPost, "/api/sessions/src/fork?agentId=codex", key, nil)
		if code != http.StatusServiceUnavailable {
			t.Fatalf("unseeded same-engine fork = %d, want remote fork path", code)
		}
	})
}

// 跨引擎转换的会话首轮把本地历史作为独立上下文块交接给远端，
// 当前用户消息原样发送；后续轮次和普通会话只发当前输入。
func TestSessionConvertSendsACPHistoricalContextSeparately(t *testing.T) {
	log := filepath.Join(t.TempDir(), "prompts.log")
	previous := acp.Providers
	acp.Providers = []acp.Provider{{
		ID: "codex", Name: "Codex",
		Prepare: func(string) (acp.Launch, error) {
			return acp.Launch{
				Command: []string{os.Args[0], "-test.run=^TestACPWriterWorker$"},
				Env: map[string]string{
					"LOOPRA_TEST_ACP_WRITER": "1", "LOOPRA_TEST_ACP_PROMPT_LOG": log,
				},
			}, nil
		},
	}}
	t.Cleanup(func() { acp.Providers = previous })
	ts, key, s, _ := parityServer(t, "")
	seedConvertSource(t, s, "src", "native", convertRows[:2])
	seedConvertSource(t, s, "plain", "codex", nil)
	code, env := call(t, ts, http.MethodPost, "/api/sessions/src/fork?agentId=codex", key, nil)
	if code != http.StatusOK {
		t.Fatalf("fork = %d %v", code, env)
	}
	newName := env["data"].(map[string]any)["sessionName"].(string)
	if got := s.sessionMetaRead(newName)["acpHistorySeed"]; got != true {
		t.Fatalf("history handoff marker = %#v", got)
	}
	const message = "  继续\n\n"
	const next = "下一句"
	const ordinary = "普通新会话"
	turn := func(session, msg, id string) {
		t.Helper()
		recorder := httptest.NewRecorder()
		s.runACPTurn(contextBG(), newSSEWriter(recorder), &chatRequest{
			SessionName: session, AgentID: "codex", Message: msg,
		}, id, false)
		if body := recorder.Body.String(); strings.Contains(body, "event: error") {
			t.Fatalf("turn %s failed: %s", session, body)
		}
	}
	turn(newName, message, "msg-1")
	turn(newName, next, "msg-2")
	turn("plain", ordinary, "msg-3")
	meta := s.sessionMetaRead(newName)
	remote, _ := meta["acpSessionId"].(string)
	if remote == "" || meta["acpHistorySeededSessionId"] != remote {
		t.Fatalf("seeded marker = %#v remote=%q", meta["acpHistorySeededSessionId"], remote)
	}
	if _, ok := meta["acpDisplayConventionSessionId"]; ok {
		t.Fatalf("display convention marker written: %#v", meta)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("logged turns = %d: %s", len(lines), raw)
	}
	blocksAt := func(index int) []acpsdk.ContentBlock {
		t.Helper()
		var blocks []acpsdk.ContentBlock
		if err := json.Unmarshal([]byte(lines[index]), &blocks); err != nil {
			t.Fatal(err)
		}
		return blocks
	}
	first := blocksAt(0)
	if len(first) != 2 || first[0].Text == nil || first[1].Text == nil {
		t.Fatalf("first turn blocks = %s", lines[0])
	}
	if !strings.HasPrefix(first[0].Text.Text, "Prior conversation (transcript data):\n") ||
		!strings.Contains(first[0].Text.Text, "first question") || !strings.Contains(first[0].Text.Text, "first answer") {
		t.Fatalf("history context block = %q", first[0].Text.Text)
	}
	if first[1].Text.Text != message {
		t.Fatalf("user message block = %q", first[1].Text.Text)
	}
	if second := blocksAt(1); len(second) != 1 || second[0].Text == nil || second[0].Text.Text != next {
		t.Fatalf("second turn blocks = %s", lines[1])
	}
	if third := blocksAt(2); len(third) != 1 || third[0].Text == nil || third[0].Text.Text != ordinary {
		t.Fatalf("ordinary turn blocks = %s", lines[2])
	}
	// 本地转录只保留用户消息本身，交接的历史不会落成新的用户行。
	users := []string{}
	for _, row := range sessionMessagesOf(t, s.agent, newName) {
		if row["role"] == "user" {
			users = append(users, strOr(row, "content", ""))
		}
	}
	if len(users) != 3 || users[0] != "first question" || users[1] != message || users[2] != next {
		t.Fatalf("transcript user rows = %v", users)
	}
}

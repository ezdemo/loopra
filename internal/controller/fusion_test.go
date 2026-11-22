package controller

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// fusionServer 搭一个项目工作区：父模型用脚本 echo，可选的 sidekick
// 渠道指向本地 OpenAI 兼容端点，disabled 进 cfg.DisabledTools，
// extras 追加进父级工具注册表。
func fusionServer(t *testing.T, lead model.LLM, sidekickBase string, disabled []string, extras ...tools.Tool) (*httptest.Server, string, *Controller) {
	t.Helper()
	reg := tools.NewRegistry(append(tools.FileTools(t.TempDir()), extras...)...)
	cfg := config.Default()
	cfg.Hitl = "free"
	cfg.DisabledTools = disabled
	if sidekickBase != "" {
		cfg.ModelChannels = append(cfg.ModelChannels, config.Channel{
			ID: "sidekick", Name: "Sidekick", BaseURL: sidekickBase, APIKey: "test-key",
			APIProtocol: "chat_completions",
			Models:      []config.ModelEntry{{Name: "side-model"}},
		})
	}
	home := t.TempDir()
	a, err := agentpkg.New(home, "a1b2c3", &cfg, agentpkg.Options{
		Model:    lead,
		Toolsets: []tool.Toolset{reg},
	})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Registry: reg, Home: home})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); ts.Close() })
	return ts, key, s
}

func fusionStream(t *testing.T, ts *httptest.Server, key, session, message string) []map[string]any {
	t.Helper()
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(fmt.Sprintf(`{"message":%q,"sessionName":%q}`, message, session)))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	events, _ := readUntilEvent(t, scanner, "done")
	for _, e := range events {
		if e["type"] == "error" {
			t.Fatalf("chat stream error: %v", e)
		}
	}
	return events
}

func subAgentCall(profile string) []*genai.FunctionCall {
	return []*genai.FunctionCall{{
		Name: "sub_agent",
		Args: map[string]any{"name": "执行者", "profile": profile, "task": "完成指派的任务"},
	}}
}

// fusionDelegateCall 生成一次 fusion_delegate 委派；专用同步工具
// 没有 name 或角色参数，也不接受选择执行模型。
func fusionDelegateCall(task, instructions string) []*genai.FunctionCall {
	args := map[string]any{"task": task}
	if instructions != "" {
		args["instructions"] = instructions
	}
	return []*genai.FunctionCall{{Name: fusionDelegateName, Args: args}}
}

// fusionTestLead 在每个 fusion_delegate 调用前插一次 checklist_update
// （把本次 Sidekick 步骤标为 active），模拟主代理"先拆解再交接"。
// 纯测试夹具，只编排脚本，不含提示词。
func fusionTestLead(name string, scripts ...echo.Script) *echo.Scripted {
	plan := echo.Script{ToolCalls: []*genai.FunctionCall{{Name: checklistUpdateName, Args: map[string]any{"steps": []map[string]any{
		{"description": "完成当前步骤", "owner": "sidekick", "status": "active"},
	}}}}}
	var out []echo.Script
	for _, script := range scripts {
		delegates := false
		for _, call := range script.ToolCalls {
			if call.Name == fusionDelegateName {
				delegates = true
			}
		}
		if delegates {
			out = append(out, plan)
		}
		out = append(out, script)
	}
	return echo.New(name, out...)
}

// sseText 生成一条 chat completions 流式文本响应。
func sseText(text string) string {
	return fmt.Sprintf("data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":%q},\"finish_reason\":null}]}\n\n", text) +
		"data: {\"id\":\"t\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
}

// fusionSegmentIDs 按出现顺序收集 Fusion 委派的就地片段标识：
// 每次交接产生一个带 segmentId 的正文/思考段，而不是 sub_* 容器。
func fusionSegmentIDs(events []map[string]any) []string {
	var out []string
	seen := map[string]bool{}
	for _, e := range events {
		if id, ok := e["segmentId"].(string); ok && id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// TestFusionSidekickKeepsHistoryAcrossHandoffs 同一父会话的多次委派
// 共享同一个执行上下文：同一轮里的第二次委派（评审反馈）与下一轮
// 的委派都能看到此前成功交接的简报与结果，但看不到父会话自己的
// 用户消息；不同会话互不续用，每次委派的回放 id 仍然独立。
func TestFusionSidekickKeepsHistoryAcrossHandoffs(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(raw))
		idx := len(bodies)
		mu.Unlock()
		texts := map[int]string{1: "explore-fusion-result", 2: "first-fusion-result", 3: "review-fusion-result", 4: "followup-fusion-result", 5: "other-fusion-result"}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseText(texts[idx]))
	}))
	defer upstream.Close()

	scripted := fusionTestLead("fusion-lead",
		// 同一轮内的连续三次委派：只读调查 → 实现 → 反馈评审。
		echo.Script{ToolCalls: fusionDelegateCall("explore-fusion-brief", "explore-fusion-constraint")},
		echo.Script{ToolCalls: fusionDelegateCall("first-fusion-brief", "")},
		echo.Script{ToolCalls: fusionDelegateCall("review-fusion-brief", "review-fusion-constraint")},
		echo.Script{Text: "第一轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("followup-fusion-brief", "followup-fusion-constraint")},
		echo.Script{Text: "第二轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("other-fusion-brief", "")},
		echo.Script{Text: "第三轮完成"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	ts.Client().Timeout = 60 * time.Second
	main := s.agent.App()
	const name = "fusion-history"
	enableFusion(t, ts, key, main, name, "sidekick:side-model")

	// 重选相同模型不轮换 epoch，上下文继续续用。
	epoch, _ := s.sessionMetaRead(name)[fusionEpochKey].(string)
	if epoch == "" {
		t.Fatal("epoch not set after enabling fusion")
	}
	enableFusion(t, ts, key, main, name, "sidekick:side-model")
	if again, _ := s.sessionMetaRead(name)[fusionEpochKey].(string); again != epoch {
		t.Fatalf("re-selecting same model rotated epoch: %q -> %q", epoch, again)
	}

	// 执行模型强度独立于主模型配置并随选择保存：强度编辑
	// 不轮换 epoch，请求把它带给执行渠道。
	code, env := call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": fusionEffortOption, "value": "high"})
	if code != http.StatusOK {
		t.Fatalf("fusion effort = %d %v", code, env)
	}
	if again, _ := s.sessionMetaRead(name)[fusionEpochKey].(string); again != epoch {
		t.Fatalf("effort edit rotated epoch: %q -> %q", epoch, again)
	}

	// 边缘会话不依赖普通子代理角色：全部禁用后交接仍正常。
	disabled := false
	profiles := builtinProfiles()
	for i := range profiles {
		profiles[i].Enable = &disabled
	}
	s.subAgentSave(profiles)

	turn1 := fusionStream(t, ts, key, name, "父会话第一条消息")
	turn2 := fusionStream(t, ts, key, name, "父会话第二条消息")
	// fusion-other 没有明确选择：首个真实轮次继承服务端默认并固定到 .meta。
	turn3 := fusionStream(t, ts, key, "fusion-other", "另一个会话的消息")
	if got := s.sessionMetaRead("fusion-other")[fusionSidekickOption]; got != "sidekick:side-model" {
		t.Fatalf("first turn did not pin inherited Fusion: %v", got)
	}
	if got := s.sessionMetaRead("fusion-other")[fusionEffortOption]; got != "high" {
		t.Fatalf("first turn did not pin inherited Fusion effort: %v", got)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 5 {
		t.Fatalf("sidekick requests = %d", len(bodies))
	}
	var system string
	wantHandoffs := []string{
		"explore-fusion-brief\n\n补充指示：\nexplore-fusion-constraint",
		"first-fusion-brief",
		"review-fusion-brief\n\n补充指示：\nreview-fusion-constraint",
		"followup-fusion-brief\n\n补充指示：\nfollowup-fusion-constraint",
		"other-fusion-brief",
	}
	for i, body := range bodies {
		var payload struct {
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoning_effort"`
			Messages        []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatalf("request %d not json: %v", i, err)
		}
		if payload.Model != "side-model" {
			t.Fatalf("request %d model = %v", i, payload.Model)
		}
		if payload.ReasoningEffort != "high" {
			t.Fatalf("request %d reasoning_effort = %v", i, payload.ReasoningEffort)
		}
		messages := payload.Messages
		if len(messages) < 2 || messages[0].Role != "system" {
			t.Fatalf("handoff %d missing system or user message: %+v", i, messages)
		}
		if i == 0 {
			system = messages[0].Content
			for _, heading := range []string{"[Runtime environment]", "[项目工作区]"} {
				if strings.Count(system, heading) != 1 {
					t.Fatalf("want one %s block in system instruction: %s", heading, system)
				}
			}
			for _, line := range []string{"Working directory: " + s.workspaceRoot(), "主项目根目录: " + s.workspaceRoot()} {
				if !strings.Contains(system, line) {
					t.Fatalf("system instruction missing %q: %s", line, system)
				}
			}
		} else if messages[0].Content != system {
			t.Fatalf("handoff %d changed the system instruction:\n%s\n---\n%s", i, system, messages[0].Content)
		}
		last := messages[len(messages)-1]
		if last.Role != "user" || last.Content != wantHandoffs[i] {
			t.Fatalf("handoff %d last message = %+v, want user message %q", i, last, wantHandoffs[i])
		}
	}
	// 各次交接使用同一套会话工具，不因任务类型切换角色权限。
	for i, body := range bodies {
		for _, want := range []string{`"name":"rg"`, `"name":"read"`, `"name":"edit"`} {
			if !strings.Contains(body, want) {
				t.Fatalf("handoff %d missing session tool %q", i, want)
			}
		}
		for _, notWant := range []string{`"name":"sub_agent"`, `"name":"fusion_delegate"`, `"name":"checklist_update"`, "本次角色", "角色约定"} {
			if strings.Contains(body, notWant) {
				t.Fatalf("handoff %d contained %q", i, notWant)
			}
		}
	}
	// 同轮实现委派看到调查结论。
	implement := bodies[1]
	for _, want := range []string{"explore-fusion-brief", "explore-fusion-result", "first-fusion-brief", `"name":"edit"`} {
		if !strings.Contains(implement, want) {
			t.Fatalf("same-turn implement handoff missing %q\nbody: %s", want, implement)
		}
	}
	// 同一轮里的反馈委派带着前两次成功交接的上下文。
	review := bodies[2]
	for _, want := range []string{"explore-fusion-brief", "explore-fusion-result", "first-fusion-brief", "first-fusion-result", "review-fusion-brief", "review-fusion-constraint"} {
		if !strings.Contains(review, want) {
			t.Fatalf("same-turn review handoff missing %q\nbody: %s", want, review)
		}
	}
	// 下一轮委派看到全部此前成功交接，但不含父会话用户消息。
	followup := bodies[3]
	for _, want := range []string{"explore-fusion-brief", "explore-fusion-result", "first-fusion-brief", "first-fusion-result", "review-fusion-brief", "review-fusion-result", "followup-fusion-brief", "followup-fusion-constraint"} {
		if !strings.Contains(followup, want) {
			t.Fatalf("next-turn handoff missing %q\nbody: %s", want, followup)
		}
	}
	for _, notWant := range []string{"父会话第一条消息", "父会话第二条消息"} {
		if strings.Contains(followup, notWant) {
			t.Fatalf("next-turn handoff leaked parent user text %q", notWant)
		}
	}
	other := bodies[4]
	if !strings.Contains(other, "other-fusion-brief") {
		t.Fatalf("other session handoff missing its task\nbody: %s", other)
	}
	for _, notWant := range []string{"explore-fusion-brief", "explore-fusion-result", "first-fusion-brief", "first-fusion-result", "review-fusion-brief", "followup-fusion-brief"} {
		if strings.Contains(other, notWant) {
			t.Fatalf("other session leaked earlier context %q", notWant)
		}
	}
	segments := fusionSegmentIDs(turn1)
	if len(segments) != 3 {
		t.Fatalf("turn 1 scoped segments = %v, want 3 handoffs", segments)
	}
	// 首个委派的最终结果先于第二次交接的就地正文开始。
	exploreResultIndex, secondScoped := -1, -1
	for i, e := range turn1 {
		if e["type"] == "content" && e["segmentId"] == segments[1] {
			if secondScoped < 0 {
				secondScoped = i
			}
		}
		if e["type"] == "tool_result" && e["name"] == fusionDelegateName && strings.Contains(fmt.Sprint(e["result"]), "explore-fusion-result") {
			exploreResultIndex = i
		}
	}
	if exploreResultIndex < 0 || secondScoped < 0 || exploreResultIndex > secondScoped {
		t.Fatalf("want explore result before second scoped segment; events=%v", turn1)
	}
	ids := map[string]bool{}
	for _, evs := range [][]map[string]any{turn1, turn2, turn3} {
		for _, id := range fusionSegmentIDs(evs) {
			ids[id] = true
		}
	}
	if len(ids) != 5 {
		t.Fatalf("fusion segments not distinct: %v", ids)
	}
}

// TestFusionSidekickDropsFailedHandoff 失败的交接不写入上下文：
// 下一次委派只看到上一次成功记录；关闭再开启会轮换 epoch，
// 上下文从零开始。
func TestFusionSidekickDropsFailedHandoff(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(raw))
		idx := len(bodies)
		mu.Unlock()
		if idx == 2 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"message":"sidekick rejected"}}`)
			return
		}
		texts := map[int]string{1: "keep-fusion-result", 3: "third-fusion-result", 4: "clean-fusion-result"}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseText(texts[idx]))
	}))
	defer upstream.Close()

	scripted := fusionTestLead("fusion-lead",
		echo.Script{ToolCalls: fusionDelegateCall("keep-fusion-brief", "")},
		echo.Script{Text: "第一轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("fail-fusion-brief", "")},
		echo.Script{Text: "第二轮失败已上报"},
		echo.Script{ToolCalls: fusionDelegateCall("third-fusion-brief", "")},
		echo.Script{Text: "第三轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("clean-fusion-brief", "")},
		echo.Script{Text: "第四轮完成"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	ts.Client().Timeout = 60 * time.Second
	main := s.agent.App()
	const name = "fusion-failed"
	enableFusion(t, ts, key, main, name, "sidekick:side-model")
	epoch, _ := s.sessionMetaRead(name)[fusionEpochKey].(string)

	fusionStream(t, ts, key, name, "第一条消息")
	failed := fusionStream(t, ts, key, name, "第二条消息")
	var failedStatus, failedResult, leadAfter string
	for _, e := range failed {
		if e["type"] == "tool_result" && e["name"] == fusionDelegateName {
			failedStatus, _ = e["status"].(string)
			failedResult = fmt.Sprint(e["result"])
		}
		if e["type"] == "content" && e["segmentId"] == nil {
			leadAfter += fmt.Sprint(e["content"])
		}
	}
	if failedStatus != "failed" {
		t.Fatalf("failed handoff delegate result = %q %q; events=%v", failedStatus, failedResult, failed)
	}
	if !strings.Contains(leadAfter, "已上报") {
		t.Fatalf("lead did not continue after failed handoff; events=%v", failed)
	}
	fusionStream(t, ts, key, name, "第三条消息")

	// 关闭再开启同一模型：epoch 轮换，上下文从零开始。
	enableFusion(t, ts, key, main, name, "off")
	enableFusion(t, ts, key, main, name, "sidekick:side-model")
	if again, _ := s.sessionMetaRead(name)[fusionEpochKey].(string); again == epoch {
		t.Fatal("off/on did not rotate epoch")
	}
	fusionStream(t, ts, key, name, "第四条消息")

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 4 {
		t.Fatalf("sidekick requests = %d", len(bodies))
	}
	third := bodies[2]
	for _, want := range []string{"keep-fusion-brief", "keep-fusion-result", "third-fusion-brief"} {
		if !strings.Contains(third, want) {
			t.Fatalf("third handoff missing %q\nbody: %s", want, third)
		}
	}
	if strings.Contains(third, "fail-fusion-brief") {
		t.Fatalf("failed handoff leaked into context\nbody: %s", third)
	}
	clean := bodies[3]
	if !strings.Contains(clean, "clean-fusion-brief") {
		t.Fatalf("fresh handoff missing its task\nbody: %s", clean)
	}
	for _, notWant := range []string{"keep-fusion-brief", "keep-fusion-result", "fail-fusion-brief", "third-fusion-brief"} {
		if strings.Contains(clean, notWant) {
			t.Fatalf("post-reset handoff leaked earlier context %q", notWant)
		}
	}
}

func enableFusion(t *testing.T, ts *httptest.Server, key, workspace, session, value string) {
	t.Helper()
	code, env := call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": workspace, "sessionName": session, "configId": "fusionSidekick", "value": value})
	if code != http.StatusOK {
		t.Fatalf("enable fusion = %d %v", code, env)
	}
}

// TestFusionConfigOption 覆盖引擎配置层的 Fusion 选项：缺省 off、
// 按会话持久化并成为新会话的服务端默认、纯聊天与未知值被拒、
// 明确关闭写入 "off"、已用旧会话不跟随默认。
func TestFusionConfigOption(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	main := s.agent.App()
	const name = "fusion-config"
	s.sessionMetaSet(name, map[string]any{"agentId": "native", "futureField": "keep"})

	optionsOf := func(env map[string]any) []any {
		return env["data"].(map[string]any)["configOptions"].([]any)
	}
	find := func(list []any, id string) map[string]any {
		for _, o := range list {
			if o.(map[string]any)["id"] == id {
				return o.(map[string]any)
			}
		}
		return nil
	}
	nativePrefs := func() map[string]any {
		data, err := os.ReadFile(s.enginePreferencesPath())
		if err != nil {
			t.Fatalf("read preferences: %v", err)
		}
		var prefs map[string]any
		if err := json.Unmarshal(data, &prefs); err != nil {
			t.Fatalf("parse preferences: %v", err)
		}
		agents, _ := prefs["agents"].(map[string]any)
		native, _ := agents["native"].(map[string]any)
		return native
	}
	optionValue := func(session, id string) any {
		code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+main+"&sessionName="+session, key, nil)
		if code != http.StatusOK {
			t.Fatalf("get config %s = %d %v", session, code, env)
		}
		if opt := find(optionsOf(env), id); opt != nil {
			return opt["currentValue"]
		}
		return nil
	}
	prepareOption := func(session, id string) any {
		body := map[string]any{"workspaceHash": main}
		if session != "" {
			body["sessionName"] = session
		}
		code, env := call(t, ts, http.MethodPost, "/api/agent-engines/prepare", key, body)
		if code != http.StatusOK {
			t.Fatalf("prepare %q = %d %v", session, code, env)
		}
		if opt := find(optionsOf(env), id); opt != nil {
			return opt["currentValue"]
		}
		return nil
	}

	// 会话没有保存过选择且服务端没有默认：选项存在且为 off / default。
	if got := optionValue(name, fusionSidekickOption); got != "off" {
		t.Fatalf("default fusion = %v", got)
	}
	if got := optionValue(name, fusionEffortOption); got != "default" {
		t.Fatalf("default fusion effort = %v", got)
	}

	// 纯聊天工作区不暴露选项，写入同样被拒。
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+chatWorkspace+"&sessionName="+name, key, nil)
	if code != http.StatusOK {
		t.Fatalf("chat get config = %d %v", code, env)
	}
	if find(optionsOf(env), "fusionSidekick") != nil || find(optionsOf(env), fusionEffortOption) != nil {
		t.Fatal("chat workspace exposes fusion options")
	}
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": chatWorkspace, "sessionName": name, "configId": "fusionSidekick", "value": "off"})
	if code != http.StatusBadRequest {
		t.Fatalf("chat PUT fusion = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": chatWorkspace, "sessionName": name, "configId": fusionEffortOption, "value": "high"})
	if code != http.StatusBadRequest {
		t.Fatalf("chat PUT fusion effort = %d %v", code, env)
	}

	// 不在目录中的组合值被拒。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "fusionSidekick", "value": "missing:model"})
	if code != http.StatusBadRequest {
		t.Fatalf("unknown fusion value = %d %v", code, env)
	}
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": fusionEffortOption, "value": "arbitrary"})
	if code != http.StatusBadRequest {
		t.Fatalf("unknown fusion effort = %d %v", code, env)
	}

	// 目录内组合值按会话持久化并成为新会话的服务端默认，
	// 未知 meta 键保留；偏好按请求从文件读取，重启后同样生效。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "fusionSidekick", "value": "default:deepseek-v4-flash"})
	if code != http.StatusOK {
		t.Fatalf("enable fusion = %d %v", code, env)
	}
	if opt := find(optionsOf(env), "fusionSidekick"); opt["currentValue"] != "default:deepseek-v4-flash" {
		t.Fatalf("fusion current = %v", opt["currentValue"])
	}
	meta := s.sessionMetaRead(name)
	if meta["fusionSidekick"] != "default:deepseek-v4-flash" || meta["futureField"] != "keep" {
		t.Fatalf("meta = %v", meta)
	}
	if native := nativePrefs(); native["fusionSidekick"] != "default:deepseek-v4-flash" {
		t.Fatalf("preference file = %v", native)
	}
	if got := optionValue("other", fusionSidekickOption); got != "default:deepseek-v4-flash" {
		t.Fatalf("other session fusion = %v", got)
	}

	// 执行模型的推理强度独立配置：按会话持久化并成为新会话的
	// 服务端默认，强度编辑不轮换模型上下文 epoch。
	epoch, _ := s.sessionMetaRead(name)[fusionEpochKey].(string)
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": fusionEffortOption, "value": "high"})
	if code != http.StatusOK {
		t.Fatalf("fusion effort = %d %v", code, env)
	}
	if opt := find(optionsOf(env), fusionEffortOption); opt["currentValue"] != "high" {
		t.Fatalf("fusion effort current = %v", opt["currentValue"])
	}
	if again, _ := s.sessionMetaRead(name)[fusionEpochKey].(string); again != epoch {
		t.Fatalf("effort edit rotated epoch: %q -> %q", epoch, again)
	}
	if native := nativePrefs(); native[fusionEffortOption] != "high" {
		t.Fatalf("effort preference = %v", native)
	}
	if got := optionValue("other", fusionEffortOption); got != "high" {
		t.Fatalf("other session fusion effort = %v", got)
	}

	// 命名与未命名的空白会话在 /prepare 都展示服务端默认。
	if got := prepareOption("blank-named", fusionSidekickOption); got != "default:deepseek-v4-flash" {
		t.Fatalf("named draft prepare fusion = %v", got)
	}
	if got := prepareOption("", fusionSidekickOption); got != "default:deepseek-v4-flash" {
		t.Fatalf("unnamed draft prepare fusion = %v", got)
	}
	if got := prepareOption("fresh-effort", fusionEffortOption); got != "high" {
		t.Fatalf("fresh draft prepare effort = %v", got)
	}

	// 已落盘的旧会话没有保存过选择：保持 off / default，不跟随新默认。
	seedSessionMessage(t, s, main, "legacy")
	if got := optionValue("legacy", fusionSidekickOption); got != "off" {
		t.Fatalf("legacy session fusion = %v", got)
	}
	if got := optionValue("legacy", fusionEffortOption); got != "default" {
		t.Fatalf("legacy session fusion effort = %v", got)
	}

	// 纯聊天会话修改普通选项时快照不含 Fusion 键；已保存的
	// Fusion 默认与普通偏好原样保留，主模型强度与执行模型强度互不影响。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": chatWorkspace, "sessionName": "chat-cfg", "configId": "effort", "value": "low"})
	if code != http.StatusOK {
		t.Fatalf("chat effort = %d %v", code, env)
	}
	if native := nativePrefs(); native["fusionSidekick"] != "default:deepseek-v4-flash" ||
		native[fusionEffortOption] != "high" || native["effort"] != "low" {
		t.Fatalf("preferences after chat write = %v", native)
	}
	if got := optionValue(name, fusionEffortOption); got != "high" {
		t.Fatalf("session fusion effort = %v", got)
	}

	// 另一会话把执行强度改回默认：服务端默认复原，已明确选择的
	// 会话保留自己的强度，且模型 epoch 不因强度编辑轮换。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": "other", "configId": fusionEffortOption, "value": "default"})
	if code != http.StatusOK {
		t.Fatalf("reset fusion effort = %d %v", code, env)
	}
	if native := nativePrefs(); native[fusionEffortOption] != "default" {
		t.Fatalf("effort preference reset = %v", native)
	}
	if got := optionValue(name, fusionEffortOption); got != "high" {
		t.Fatalf("explicit effort followed default reset: %v", got)
	}
	if again, _ := s.sessionMetaRead(name)[fusionEpochKey].(string); again != epoch {
		t.Fatalf("effort reset rotated epoch: %q -> %q", epoch, again)
	}

	// 另一会话显式关闭：服务端默认改回 off，新 prepare 展示 off；
	// 已明确选择的会话保留自己的选择。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": "other", "configId": "fusionSidekick", "value": "off"})
	if code != http.StatusOK {
		t.Fatalf("disable fusion = %d %v", code, env)
	}
	if native := nativePrefs(); native["fusionSidekick"] != "off" {
		t.Fatalf("preference off = %v", native)
	}
	if got := prepareOption("new-draft", fusionSidekickOption); got != "off" {
		t.Fatalf("draft after off = %v", got)
	}
	if got := optionValue(name, fusionSidekickOption); got != "default:deepseek-v4-flash" {
		t.Fatalf("explicit session followed default change: %v", got)
	}
	if got := s.sessionMetaRead("other")["fusionSidekick"]; got != "off" {
		t.Fatalf("explicit off not retained in meta: %v", got)
	}

	// 别处重新开启后，显式 off 的选择不变。
	enableFusion(t, ts, key, main, "third", "default:deepseek-v4-flash")
	if got := optionValue("other", fusionSidekickOption); got != "off" {
		t.Fatalf("explicit off followed re-enable: %v", got)
	}
	if got := optionValue("legacy", fusionSidekickOption); got != "off" {
		t.Fatalf("legacy session followed re-enable: %v", got)
	}

	// 显式关闭写入 "off" 而不是删键，其余 meta 字段不受影响。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "fusionSidekick", "value": "off"})
	if code != http.StatusOK {
		t.Fatalf("disable fusion = %d %v", code, env)
	}
	meta = s.sessionMetaRead(name)
	if meta["fusionSidekick"] != "off" {
		t.Fatalf("meta fusion = %v", meta)
	}
	if meta["futureField"] != "keep" {
		t.Fatalf("meta lost futureField: %v", meta)
	}
}

// TestFusionConfigPreferenceWriteFailure 偏好文件不可读时保存
// Fusion 选择返回失败，且不向会话写入任何选择。
func TestFusionConfigPreferenceWriteFailure(t *testing.T) {
	ts, key, s, _ := parityServer(t, "")
	main := s.agent.App()
	if parent := filepath.Dir(s.enginePreferencesPath()); parent != s.home {
		t.Fatalf("unexpected preferences parent: %s", parent)
	}
	if err := os.Mkdir(s.enginePreferencesPath(), 0o700); err != nil {
		t.Fatal(err)
	}
	code, env := call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": "blocked", "configId": "fusionSidekick", "value": "default:deepseek-v4-flash"})
	if code != http.StatusInternalServerError || env["success"] != false {
		t.Fatalf("unreadable preferences PUT = %d %v", code, env)
	}
	if got := s.sessionMetaRead("blocked")["fusionSidekick"]; got != nil {
		t.Fatalf("failed write still set session fusion: %v", got)
	}
}

// TestFusionSidekickRunsImplement 走完整聊天流：父代理委派一次实现任务，
// 子代理改打本地 sidekick 渠道，执行文本作为带 segmentId 的就地正文与
// 工具结果回到父流（不出现任何 sub_* 事件），被禁用的工具不出现在
// 执行模型的请求里。
func TestFusionSidekickRunsImplement(t *testing.T) {
	var requests atomic.Int32
	var gotModel, gotBody atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		requests.Add(1)
		var payload map[string]any
		_ = json.Unmarshal(raw, &payload)
		gotModel.Store(payload["model"])
		gotBody.Store(string(raw))
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"执行模型已完成实现\"},\"finish_reason\":null}]}\n\n")
		fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	scripted := fusionTestLead("fusion-lead",
		echo.Script{ToolCalls: fusionDelegateCall("实现登录页", "")},
		echo.Script{Text: "已亲自核对执行模型的改动，可以交付"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", []string{"write"})
	enableFusion(t, ts, key, s.agent.App(), "fusion-run", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-run", "实现登录页")
	types := eventTypes(events)
	for _, typ := range types {
		if strings.HasPrefix(typ, "sub_") {
			t.Fatalf("fusion stream leaked %q; events=%v", typ, events)
		}
	}
	complete := false
	for _, typ := range types {
		if typ == "complete" {
			complete = true
		}
	}
	if !complete {
		t.Fatalf("missing complete; events=%v", events)
	}
	if requests.Load() != 1 {
		t.Fatalf("sidekick requests = %d", requests.Load())
	}
	if gotModel.Load() != "side-model" {
		t.Fatalf("sidekick model = %v", gotModel.Load())
	}
	var runBody map[string]any
	if err := json.Unmarshal([]byte(fmt.Sprint(gotBody.Load())), &runBody); err != nil {
		t.Fatalf("sidekick body not json: %v", err)
	}
	if _, has := runBody["reasoning_effort"]; has {
		t.Fatalf("default fusion effort sent reasoning_effort: %v", runBody["reasoning_effort"])
	}
	var scopedText, toolResult, final, segment string
	scopedIndex, toolResultIndex, finalIndex := -1, -1, -1
	planResultIndex := -1
	for i, e := range events {
		switch e["type"] {
		case "content":
			if id, _ := e["segmentId"].(string); id != "" {
				if scopedIndex < 0 {
					scopedIndex, segment = i, id
				}
				if id != segment {
					t.Fatalf("single handoff produced multiple segments: %v", events)
				}
				scopedText += fmt.Sprint(e["content"])
				continue
			}
			if finalIndex < 0 && fmt.Sprint(e["content"]) != "" {
				finalIndex = i
			}
			final += fmt.Sprint(e["content"])
		case "tool_result":
			if n, _ := e["name"].(string); n == fusionDelegateName {
				if toolResultIndex >= 0 {
					t.Fatalf("multiple fusion_delegate tool_result events; events=%v", events)
				}
				toolResultIndex = i
				toolResult = fmt.Sprint(e["result"])
			}
			if n, _ := e["name"].(string); n == checklistUpdateName {
				planResultIndex = i
			}
		}
	}
	if scopedText != "执行模型已完成实现" {
		t.Fatalf("scoped content = %q", scopedText)
	}
	if !strings.Contains(toolResult, "执行模型已完成实现") {
		t.Fatalf("fusion_delegate tool_result = %q", toolResult)
	}
	if !strings.Contains(final, "可以交付") {
		t.Fatalf("parent final = %q; events=%v", final, events)
	}
	// 同步委派：Sidekick 正文先就地呈现，最终结果回到
	// fusion_delegate，主代理再产出自己的内容。
	if scopedIndex < 0 || toolResultIndex <= scopedIndex || finalIndex <= toolResultIndex {
		t.Fatalf("want scoped content before fusion_delegate result before lead content; events=%v", events)
	}
	// 先拆解再交接：计划成功的 tool_result 先于首个就地正文。
	if planResultIndex < 0 || planResultIndex > scopedIndex {
		t.Fatalf("want checklist_update result before first scoped content; events=%v", events)
	}
	// Fusion 执行记录是内部审计，不进可回放的子会话列表。
	code, env := call(t, ts, http.MethodGet,
		"/api/sub-sessions?workspaceHash="+s.agent.App()+"&sessionName=fusion-run", key, nil)
	if code != http.StatusOK {
		t.Fatalf("sub-sessions = %d %v", code, env)
	}
	if list := env["data"].([]any); len(list) != 0 {
		t.Fatalf("fusion run leaked sub sessions: %v", list)
	}
	// 历史里委派行还原为普通工具结果并附就地回放事件。
	code, env = call(t, ts, http.MethodGet,
		"/api/agent/history?workspaceHash="+s.agent.App()+"&sessionName=fusion-run", key, nil)
	if code != http.StatusOK {
		t.Fatalf("history = %d %v", code, env)
	}
	var delegateRow map[string]any
	for _, item := range env["data"].([]any) {
		if row := item.(map[string]any); row["role"] == "tool" && row["tool_name"] == fusionDelegateName {
			delegateRow = row
		}
	}
	if delegateRow == nil {
		t.Fatalf("no fusion_delegate tool row; history=%v", env["data"])
	}
	if delegateRow["content"] != "执行模型已完成实现" || delegateRow["tool_status"] != "completed" {
		t.Fatalf("delegate row = %v", delegateRow)
	}
	fused, ok := delegateRow["fusion_events"].([]any)
	if !ok {
		t.Fatalf("delegate row missing fusion_events: %v", delegateRow)
	}
	var replayed string
	for _, item := range fused {
		if ev := item.(map[string]any); ev["type"] == "content" && ev["segmentId"] == segment {
			replayed += fmt.Sprint(ev["content"])
		}
	}
	if replayed != scopedText {
		t.Fatalf("history fusion_events content = %q, live scoped = %q", replayed, scopedText)
	}
	// .sub 审计仍按旧格式保留内部记录：resumable:false 且以
	// sub_end completed 收尾。
	audit, err := readSubEvents(filepath.Join(s.subSessionsDir("fusion-run"), segment+".jsonl"))
	if err != nil {
		t.Fatalf("fusion audit unreadable (segment=%q): %v", segment, err)
	}
	if !isFusionTranscript(audit) {
		t.Fatalf("fusion audit missing resumable:false start: %v", audit)
	}
	last := audit[len(audit)-1]
	if last["type"] != "sub_end" || last["status"] != "completed" {
		t.Fatalf("fusion audit tail = %v", last)
	}
	if raw := fmt.Sprint(gotBody.Load()); strings.Contains(raw, `"name":"write"`) ||
		strings.Contains(raw, `"name":"fusion_delegate"`) || strings.Contains(raw, `"name":"checklist_update"`) ||
		!strings.Contains(raw, `"name":"edit"`) {
		t.Fatalf("sidekick tool list not filtered: %s", raw)
	}
}

// TestFusionOffKeepsParentModel 未开启 Fusion 的会话里同样的
// implement 委派仍使用父模型，不触达 sidekick 渠道。
func TestFusionOffKeepsParentModel(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"不应到达\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	scripted := echo.New("plain-lead",
		echo.Script{ToolCalls: subAgentCall("implement")},
		echo.Script{Text: "子代理沿用父模型回复"},
		echo.Script{Text: "父代理总结"},
	)
	ts, key, _ := fusionServer(t, scripted, upstream.URL+"/v1", nil)

	events := fusionStream(t, ts, key, "plain-session", "实现")
	var subText, subEnd string
	for _, e := range events {
		switch e["type"] {
		case "sub_content":
			subText += fmt.Sprint(e["token"])
		case "sub_end":
			subEnd, _ = e["status"].(string)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("sidekick contacted without fusion: %d", requests.Load())
	}
	if subEnd != "completed" || !strings.Contains(subText, "子代理沿用父模型回复") {
		t.Fatalf("sub run = %q %q; events=%v", subEnd, subText, events)
	}
}

// TestFusionLeavesOrdinarySubAgentOnParentModel 开启 Fusion 后普通
// sub_agent 完全不受影响：任何角色（含 implement）都沿用父模型，
// 只有 fusion_delegate 才会路由到执行模型。
func TestFusionLeavesOrdinarySubAgentOnParentModel(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"不应到达\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	scripted := echo.New("explore-lead",
		echo.Script{ToolCalls: subAgentCall("explore")},
		echo.Script{Text: "探索角色沿用父模型"},
		echo.Script{ToolCalls: subAgentCall("implement")},
		echo.Script{Text: "实现角色沿用父模型"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)

	for _, tc := range []struct {
		session, want string
	}{
		{"fusion-plain-explore", "探索角色沿用父模型"},
		{"fusion-plain-implement", "实现角色沿用父模型"},
	} {
		enableFusion(t, ts, key, s.agent.App(), tc.session, "sidekick:side-model")
		events := fusionStream(t, ts, key, tc.session, "委派")
		var subText, subEnd string
		for _, e := range events {
			switch e["type"] {
			case "sub_content":
				subText += fmt.Sprint(e["token"])
			case "sub_end":
				subEnd, _ = e["status"].(string)
			}
		}
		if subEnd != "completed" || !strings.Contains(subText, tc.want) {
			t.Fatalf("%s sub run = %q %q; events=%v", tc.session, subEnd, subText, events)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("ordinary sub_agent reached sidekick: %d", requests.Load())
	}
}

// TestFusionDelegateIsSynchronous fusion_delegate 只在开启 Fusion 的
// 原生轮次注册，且是同步工具：无 Async 元数据、无 yield 参数、
// schema 只有 task 与可选 instructions；普通 sub_agent 保持可让出的异步语义。
func TestFusionDelegateIsSynchronous(t *testing.T) {
	ts, key, s := fusionServer(t, echo.New("idle-lead"), "http://127.0.0.1:9/v1", nil)
	// plain-sync 在设置服务端默认之前准备：继承当时的 off 并固定下来，
	// 之后的默认变化不再影响它。
	plain, err := s.prepareTurn(&chatRequest{SessionName: "plain-sync"})
	if err != nil {
		t.Fatal(err)
	}
	defer plain.closeTurnTools()
	enableFusion(t, ts, key, s.agent.App(), "fusion-sync", "sidekick:side-model")

	entries := func(turn *Controller) map[string]tools.Tool {
		out := map[string]tools.Tool{}
		for _, e := range turn.registry.Entries() {
			out[e.Meta.Name] = e
		}
		return out
	}

	fused, err := s.prepareTurn(&chatRequest{SessionName: "fusion-sync"})
	if err != nil {
		t.Fatal(err)
	}
	defer fused.closeTurnTools()
	got := entries(fused)
	sub, ok := got["sub_agent"]
	if !ok || !sub.Meta.Async {
		t.Fatalf("sub_agent registration = %+v (found=%v)", sub.Meta, ok)
	}
	del, ok := got[fusionDelegateName]
	if !ok {
		t.Fatalf("fusion_delegate not registered; tools=%v", got)
	}
	if del.Meta.Async {
		t.Fatalf("fusion_delegate must be synchronous, meta=%+v", del.Meta)
	}
	declarer, ok := del.Tool.(interface {
		Declaration() *genai.FunctionDeclaration
	})
	if !ok || declarer.Declaration() == nil {
		t.Fatal("fusion_delegate has no declaration")
	}
	schema, _ := json.Marshal(declarer.Declaration().ParametersJsonSchema)
	for _, want := range []string{`"task"`, `"instructions"`} {
		if !strings.Contains(string(schema), want) {
			t.Fatalf("fusion_delegate schema %s missing %s", schema, want)
		}
	}
	for _, notWant := range []string{`"profile"`, `"yield_after_ms"`} {
		if strings.Contains(string(schema), notWant) {
			t.Fatalf("fusion_delegate schema must not contain %s: %s", notWant, schema)
		}
	}
	check, ok := got[checklistUpdateName]
	if !ok || !check.Meta.ReadOnly || check.Meta.Async {
		t.Fatalf("checklist_update registration = %+v (found=%v)", check.Meta, ok)
	}
	if _, ok := got["fusion_plan"]; ok {
		t.Fatal("retired fusion_plan must not be advertised")
	}

	plainEntries := entries(plain)
	plainCheck, ok := plainEntries[checklistUpdateName]
	if !ok || !plainCheck.Meta.ReadOnly || plainCheck.Meta.Async {
		t.Fatalf("plain checklist_update registration = %+v (found=%v)", plainCheck.Meta, ok)
	}
	if _, ok := plainEntries[fusionDelegateName]; ok {
		t.Fatal("fusion_delegate leaked into a non-Fusion turn")
	}
	if _, ok := plainEntries["fusion_plan"]; ok {
		t.Fatal("retired fusion_plan must not be advertised")
	}
	if !strings.Contains(fused.agent.Instruction(), "同一个连续的边缘会话") || !strings.Contains(fused.agent.Instruction(), "记得此前成功交接") {
		t.Fatal("Fusion lead was not told the edge session is continuous")
	}
	if strings.Contains(plain.agent.Instruction(), "同一个连续的边缘会话") {
		t.Fatal("Fusion instruction leaked into a non-Fusion turn")
	}
}

// TestChecklistUpdateInOrdinaryTurn 普通轮次也可用 checklist_update：
// owner 省略即主代理负责；非 Fusion 会话把步骤标给 sidekick 会被拒绝。
// 清单只写进普通工具记录，不触发任何子会话。
func TestChecklistUpdateInOrdinaryTurn(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	valid := echo.Script{ToolCalls: []*genai.FunctionCall{{Name: checklistUpdateName, Args: map[string]any{"steps": []map[string]any{
		{"description": "核实调用链", "status": "active"},
		{"description": "补充回归测试", "status": "pending"},
	}}}}}
	sidekickOutsideFusion := echo.Script{ToolCalls: []*genai.FunctionCall{{Name: checklistUpdateName, Args: map[string]any{"steps": []map[string]any{
		{"description": "交给执行代理", "owner": "sidekick", "status": "active"},
	}}}}}
	scripted := echo.New("plain-lead",
		valid,
		sidekickOutsideFusion,
		echo.Script{Text: "清单已同步"},
	)
	ts, key, _ := fusionServer(t, scripted, upstream.URL+"/v1", nil)

	events := fusionStream(t, ts, key, "plain-checklist", "整理待办")
	results := []map[string]any{}
	subStarts := 0
	for _, e := range events {
		switch e["type"] {
		case "sub_start":
			subStarts++
		case "tool_result":
			if n, _ := e["name"].(string); n == checklistUpdateName {
				results = append(results, e)
			}
		}
	}
	if len(results) != 2 {
		t.Fatalf("checklist_update tool_result count = %d; events=%v", len(results), events)
	}
	if results[0]["status"] != "completed" || results[0]["result"] != checklistUpdated {
		t.Fatalf("first checklist result = %v", results[0])
	}
	if results[1]["status"] != "failed" || !strings.Contains(fmt.Sprint(results[1]["result"]), "仅 Fusion 模式可设为 sidekick") {
		t.Fatalf("second checklist result = %v", results[1])
	}
	if subStarts != 0 || requests.Load() != 0 {
		t.Fatalf("checklist leaked to sidekick: sub_start=%d requests=%d", subStarts, requests.Load())
	}
}

// TestFusionDelegateRequiresActivePlan 未在 checklist_update 中把 Sidekick
// 步骤标为 active 时委派在工具层被拒绝：不触达执行模型，不产生
// 子会话；把负责人标为 lead 同样不放行。
func TestFusionDelegateRequiresActivePlan(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	leadActive := echo.Script{ToolCalls: []*genai.FunctionCall{{Name: checklistUpdateName, Args: map[string]any{"steps": []map[string]any{
		{"description": "主代理先亲自核实", "owner": "lead", "status": "active"},
		{"description": "随后交给执行代理", "owner": "sidekick", "status": "pending"},
	}}}}}
	scripted := echo.New("guard-lead",
		echo.Script{ToolCalls: fusionDelegateCall("实现", "")},
		leadActive,
		echo.Script{ToolCalls: fusionDelegateCall("实现", "")},
		echo.Script{Text: "计划未就绪，委派被计划门卫拒绝"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	enableFusion(t, ts, key, s.agent.App(), "fusion-guard", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-guard", "实现")
	failed := 0
	for _, e := range events {
		if e["type"] == "tool_result" {
			if n, _ := e["name"].(string); n == fusionDelegateName && e["status"] == "failed" {
				if !strings.Contains(fmt.Sprint(e["result"]), checklistUpdateName) {
					t.Fatalf("delegate failure should mention %s: %q", checklistUpdateName, e["result"])
				}
				failed++
			}
		}
	}
	if failed != 2 || len(fusionSegmentIDs(events)) != 0 {
		t.Fatalf("failed delegates = %d, scoped segments = %v; events=%v", failed, fusionSegmentIDs(events), events)
	}
	if requests.Load() != 0 {
		t.Fatalf("rejected delegates reached sidekick: %d", requests.Load())
	}
}

// TestFusionDelegateRequiresFreshPlanForNextHandoff 一次计划更新只授权
// 一次交接：首个委派完成后，未刷新计划直接再委派会被计划门卫拒绝，
// 不触达执行模型，也不产生第二个子会话。
func TestFusionDelegateRequiresFreshPlanForNextHandoff(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseText("first-result"))
	}))
	defer upstream.Close()

	sidekickActive := echo.Script{ToolCalls: []*genai.FunctionCall{{Name: checklistUpdateName, Args: map[string]any{"steps": []map[string]any{
		{"description": "实现第一步", "owner": "sidekick", "status": "active"},
	}}}}}
	scripted := echo.New("fresh-plan-lead",
		sidekickActive,
		echo.Script{ToolCalls: fusionDelegateCall("first-brief", "")},
		echo.Script{ToolCalls: fusionDelegateCall("stale-brief", "")},
		echo.Script{Text: "第二项交接前需要刷新计划"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	enableFusion(t, ts, key, s.agent.App(), "fusion-fresh", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-fresh", "干活")
	delegateOK, delegateFailed := 0, 0
	for _, e := range events {
		if e["type"] == "tool_result" {
			if n, _ := e["name"].(string); n != fusionDelegateName {
				continue
			}
			if e["status"] == "failed" {
				if !strings.Contains(fmt.Sprint(e["result"]), checklistUpdateName) {
					t.Fatalf("stale delegate failure should mention %s: %q", checklistUpdateName, e["result"])
				}
				delegateFailed++
			} else {
				delegateOK++
			}
		}
	}
	if delegateOK != 1 || delegateFailed != 1 || len(fusionSegmentIDs(events)) != 1 {
		t.Fatalf("delegates ok=%d failed=%d segments=%v; events=%v", delegateOK, delegateFailed, fusionSegmentIDs(events), events)
	}
	if requests.Load() != 1 {
		t.Fatalf("sidekick requests = %d, want 1 (first-brief only)", requests.Load())
	}
}

// TestFusionSidekickFailure 执行模型返回不可重试错误时，委派工具按
// 失败结束并把失败如实回给父代理，不回退到父模型。
func TestFusionSidekickFailure(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"sidekick rejected"}}`)
	}))
	defer upstream.Close()

	scripted := fusionTestLead("failing-lead",
		echo.Script{ToolCalls: fusionDelegateCall("实现", "")},
		echo.Script{Text: "执行模型失败，已如实上报"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	enableFusion(t, ts, key, s.agent.App(), "fusion-fail", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-fail", "实现")
	var toolStatus, toolResult, final string
	for _, e := range events {
		switch e["type"] {
		case "tool_result":
			if n, _ := e["name"].(string); n == fusionDelegateName {
				toolStatus, _ = e["status"].(string)
				toolResult = fmt.Sprint(e["result"])
			}
		case "content":
			final += fmt.Sprint(e["content"])
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("sidekick requests = %d", requests.Load())
	}
	if toolStatus != "failed" || !strings.Contains(toolResult, "400") {
		t.Fatalf("fusion_delegate tool_result = %q %q; events=%v", toolStatus, toolResult, events)
	}
	if !strings.Contains(final, "已如实上报") {
		t.Fatalf("parent final = %q; events=%v", final, events)
	}
}

// TestFusionWorkerInheritsSessionApproval 会话级 hitl 覆盖透传给
// 执行模型：全局 free + 会话 approval 时，worker 的非只读
// 工具调用停在 sub_choice，POST /chat/permission 放行后才真正执行。
func TestFusionWorkerInheritsSessionApproval(t *testing.T) {
	var calls atomic.Int32
	fixture, err := functiontool.New[struct{}, map[string]any](functiontool.Config{
		Name: "fixture_check", Description: "测试计数工具",
	}, func(agentctx.Context, struct{}) (map[string]any, error) {
		calls.Add(1)
		return map[string]any{"result": "fixture ran"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		if requests.Add(1) == 1 {
			fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fx\",\"type\":\"function\",\"function\":{\"name\":\"fixture_check\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"执行模型完成\"},\"finish_reason\":null}]}\n\n")
		fmt.Fprint(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	scripted := fusionTestLead("approval-lead",
		echo.Script{ToolCalls: fusionDelegateCall("干活", "")},
		echo.Script{Text: "执行模型已获准并完成"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil,
		tools.Tool{Tool: fixture, Meta: tools.Metadata{Name: "fixture_check", ReadOnly: false}})
	main := s.agent.App()
	const name = "fusion-approve"
	enableFusion(t, ts, key, main, name, "sidekick:side-model")
	// 会话级覆盖：全局 free，但该会话要求逐次审批。
	call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "mode", "value": "approval"})

	req, _ := http.NewRequest("POST", ts.URL+"/api/chat/stream",
		strings.NewReader(fmt.Sprintf(`{"message":"干活","sessionName":%q}`, name)))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	approve := func(requestID string) {
		t.Helper()
		code, env := call(t, ts, http.MethodPost, "/api/chat/permission", key, map[string]any{
			"workspaceHash": main, "sessionName": name,
			"permissionRequestId": requestID, "optionId": "allow_once",
		})
		if code != http.StatusOK {
			t.Fatalf("approve = %d %v", code, env)
		}
	}

	// 会话 approval 模式下父代理的 fusion_delegate 调用本身先要审批。
	_, choice := readUntilEvent(t, scanner, "choice")
	approve(fmt.Sprint(choice["permissionRequestId"]))

	// 执行模型的非只读工具停在父会话的普通 choice（不是
	// sub_choice 容器事件）：审批前不得执行。
	prefix, workerChoice := readUntilEvent(t, scanner, "choice")
	if calls.Load() != 0 {
		t.Fatalf("fixture ran before approval; choice=%v", workerChoice)
	}
	workerRequestID, _ := workerChoice["permissionRequestId"].(string)
	if workerRequestID == "" {
		t.Fatalf("worker choice missing permissionRequestId: %v", workerChoice)
	}
	if _, has := workerChoice["subId"]; has {
		t.Fatalf("fusion worker approval must not be a sub choice: %v", workerChoice)
	}
	approve(workerRequestID)

	events, _ := readUntilEvent(t, scanner, "done")
	if calls.Load() != 1 {
		t.Fatalf("fixture calls = %d; events=%v", calls.Load(), events)
	}
	if requests.Load() != 2 {
		t.Fatalf("sidekick requests = %d", requests.Load())
	}
	var callID, resolvedID, resolvedOption, delegateStatus string
	resultCount := 0
	for _, e := range append(prefix, events...) {
		switch e["type"] {
		case "tool_call":
			if e["name"] == "fixture_check" {
				callID, _ = e["toolCallId"].(string)
			}
		case "tool_result":
			if e["name"] == "fixture_check" {
				resultCount++
				if id, _ := e["toolCallId"].(string); id != callID || !strings.HasPrefix(id, "fusion:") {
					t.Fatalf("fixture result toolCallId = %q, want namespaced %q", id, callID)
				}
			}
			if e["name"] == fusionDelegateName {
				delegateStatus, _ = e["status"].(string)
			}
		case "permission_resolved":
			resolvedID, _ = e["permissionRequestId"].(string)
			resolvedOption, _ = e["optionId"].(string)
		}
	}
	if !strings.HasPrefix(callID, "fusion:") {
		t.Fatalf("fixture toolCallId not namespaced: %q", callID)
	}
	if resultCount != 1 {
		t.Fatalf("fixture results = %d; events=%v", resultCount, append(prefix, events...))
	}
	if resolvedID != workerRequestID || resolvedOption != "allow_once" {
		t.Fatalf("permission_resolved = %q %q, want %q allow_once", resolvedID, resolvedOption, workerRequestID)
	}
	if delegateStatus != "completed" {
		t.Fatalf("delegate result = %q; events=%v", delegateStatus, events)
	}
}

// TestFusionSidekickUsesParentCancellation Fusion 委派不套用
// subAgentTimeoutSec：交接可以运行得比子代理执行上限更久；父轮次
// 取消时执行模型的在途请求立即随父上下文一起取消。
func TestFusionSidekickUsesParentCancellation(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	canceled := make(chan struct{}, 1)
	stopUpstream := make(chan struct{})
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		n := upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		select {
		case started <- struct{}{}:
		default:
		}
		if n == 1 {
			select {
			case <-release:
				fmt.Fprint(w, sseText("after-agent-limit"))
			case <-r.Context().Done():
			case <-stopUpstream:
			}
			return
		}
		select {
		case <-r.Context().Done():
			canceled <- struct{}{}
		case <-stopUpstream:
		}
	}))
	defer func() {
		close(stopUpstream)
		upstream.Close()
	}()

	scripted := fusionTestLead("cancel-lead",
		echo.Script{ToolCalls: fusionDelegateCall("hold", "")},
		echo.Script{Text: "第一组交接完成"},
		echo.Script{ToolCalls: fusionDelegateCall("hold-again", "")},
		echo.Script{Text: "不应到达"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	ts.Client().Timeout = 30 * time.Second
	// 子代理执行上限 1 秒：普通 sub_agent 此时会被超时终止，
	// Fusion 交接只随父轮次的取消结束。
	s.cfg.SubAgentTimeoutSec = 1
	main := s.agent.App()
	const name = "fusion-cancel"
	enableFusion(t, ts, key, main, name, "sidekick:side-model")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(fmt.Sprintf(`{"message":"hold","sessionName":%q,"requestId":"cancel-1"}`, name)))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("first sidekick request did not start")
	}
	// 持有超过 subAgentTimeoutSec 再放行：委派必须仍然成功完成。
	timer := time.NewTimer(1200 * time.Millisecond)
	<-timer.C
	close(release)

	events, _ := readUntilEvent(t, scanner, "done")
	var delegateStatus, delegateResult, final string
	for _, e := range events {
		switch e["type"] {
		case "tool_result":
			if e["name"] == fusionDelegateName {
				delegateStatus, _ = e["status"].(string)
				delegateResult = fmt.Sprint(e["result"])
			}
		case "content":
			if e["segmentId"] == nil {
				final += fmt.Sprint(e["content"])
			}
		}
	}
	if delegateStatus != "completed" || !strings.Contains(delegateResult, "after-agent-limit") {
		t.Fatalf("delegate after configured limit = %q %q; events=%v", delegateStatus, delegateResult, events)
	}
	if !strings.Contains(final, "第一组交接完成") {
		t.Fatalf("lead did not finish after slow delegate; events=%v", events)
	}

	// 第二个交接挂起后中止父轮次：在途的执行模型请求必须随
	// 父上下文取消，而不是继续跑完。
	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(fmt.Sprintf(`{"message":"hold-again","sessionName":%q,"requestId":"cancel-2"}`, name)))
	req2.Header.Set("X-Loopra-Key", key)
	resp2, err := ts.Client().Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("second sidekick request did not start")
	}
	code, result := call(t, ts, http.MethodPost, "/api/chat/abort", key,
		map[string]any{"requestId": "cancel-2", "sessionName": name})
	if code != http.StatusOK || result["data"].(map[string]any)["matched"] != float64(1) {
		t.Fatalf("abort = %d %v", code, result)
	}
	select {
	case <-canceled:
	case <-time.After(10 * time.Second):
		t.Fatal("abort did not reach the in-flight sidekick request")
	}
	events2, _ := readUntilEvent(t, bufio.NewScanner(resp2.Body), "done")
	var delegateOK, leadSuccess bool
	for _, e := range events2 {
		if e["type"] == "tool_result" && e["name"] == fusionDelegateName && e["status"] == "completed" {
			delegateOK = true
		}
		if e["type"] == "content" && strings.Contains(fmt.Sprint(e["content"]), "不应到达") {
			leadSuccess = true
		}
	}
	if delegateOK || leadSuccess {
		t.Fatalf("aborted turn produced success events: %v", events2)
	}
}

// fusionRecoveryLead 包装脚本化主模型，记录每次请求的原始入参，
// 用来核对恢复要点只出现在系统提示里而不进请求历史。
type fusionRecoveryLead struct {
	model.LLM
	saw func(*model.LLMRequest)
}

func (l fusionRecoveryLead) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	l.saw(req)
	return l.LLM.GenerateContent(ctx, req, stream)
}

func llmRequestText(req *model.LLMRequest, system bool) string {
	var sb strings.Builder
	if system {
		if req.Config != nil && req.Config.SystemInstruction != nil {
			for _, p := range req.Config.SystemInstruction.Parts {
				if p != nil {
					sb.WriteString(p.Text)
				}
			}
		}
		return sb.String()
	}
	for _, c := range req.Contents {
		if c == nil {
			continue
		}
		for _, p := range c.Parts {
			if p != nil {
				sb.WriteString(p.Text)
			}
		}
	}
	return sb.String()
}

// TestFusionRecoveryNoteReachesNextLeadTurn 主代理轮次在交接阻塞时被
// 中止：执行代理已落盘的写和工具终态留在 .sub/.fusion-recovery.json。
// 下一轮同一作用域把要点作为隐藏的模型角色事件一次性追加进历史
// （位于用户文本之前），系统提示不变，可见历史 API 不含要点；
// 追加即确认删除文件，之后轮次里内容保持稳定且不会因重放重复。
func TestFusionRecoveryNoteReachesNextLeadTurn(t *testing.T) {
	work := t.TempDir()
	target := filepath.Join(work, "worker-output.txt")
	args, _ := json.Marshal(map[string]string{"path": target, "content": "worker landed this"})
	argJSON, _ := json.Marshal(string(args))

	second := make(chan struct{}, 1)
	stopUpstream := make(chan struct{})
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		if upstreamCalls.Add(1) == 1 {
			fmt.Fprintf(w, "data: {\"id\":\"t\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_write\",\"type\":\"function\",\"function\":{\"name\":\"write\",\"arguments\":%s}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", argJSON)
			return
		}
		// 第二次模型调用发出后挂起：交接永远收不到终态回复。
		select {
		case second <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-stopUpstream:
		}
	}))
	defer func() { close(stopUpstream); upstream.Close() }()

	var mu sync.Mutex
	var seen []*model.LLMRequest
	scripted := fusionTestLead("recovery-lead",
		echo.Script{ToolCalls: fusionDelegateCall("recovery-task-marker", "")},
		echo.Script{Text: "follow-up lead reply"},
		echo.Script{Text: "third lead reply"},
	)
	lead := fusionRecoveryLead{LLM: scripted, saw: func(req *model.LLMRequest) {
		mu.Lock()
		seen = append(seen, req)
		mu.Unlock()
	}}
	ts, key, s := fusionServer(t, lead, upstream.URL+"/v1", nil)
	ts.Client().Timeout = 60 * time.Second
	main := s.agent.App()
	const name = "fusion-recovery"
	enableFusion(t, ts, key, main, name, "sidekick:side-model")

	waitReleased := func() {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if s.sessionRunning(name) == "" {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("session %q still running", name)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/chat/stream",
		strings.NewReader(fmt.Sprintf(`{"message":"begin","sessionName":%q,"requestId":"recovery-1"}`, name)))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	select {
	case <-second:
	case <-time.After(15 * time.Second):
		t.Fatal("second sidekick request did not start")
	}
	// 交接内的写工具已真正落盘，恢复要点记录该路径。
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(target); err == nil && string(data) == "worker landed this" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "worker landed this" {
		t.Fatalf("worker write = %v %q", err, data)
	}
	code, result := call(t, ts, http.MethodPost, "/api/chat/abort", key,
		map[string]any{"requestId": "recovery-1", "sessionName": name})
	if code != http.StatusOK || result["data"].(map[string]any)["matched"] != float64(1) {
		t.Fatalf("abort = %d %v", code, result)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	if events, _ := readUntilEvent(t, scanner, "done"); events == nil {
		t.Fatal("aborted stream ended without done")
	}
	waitReleased()

	// 中止让交接要点留在 pending 文件里；保留原始字节，第三轮前用它
	// 模拟"事件已追加、文件未删除"的崩溃窗口来验证稳定 ID 去重。
	recoveryPath := filepath.Join(s.subSessionsDir(name), ".fusion-recovery.json")
	pending, err := os.ReadFile(recoveryPath)
	if err != nil {
		t.Fatalf("pending recovery file: %v", err)
	}

	mu.Lock()
	before := len(seen)
	req1 := seen[0]
	mu.Unlock()
	fusionStream(t, ts, key, name, "follow up")
	waitReleased()

	var req2 *model.LLMRequest
	mu.Lock()
	if len(seen) > before {
		req2 = seen[before]
	}
	count := len(seen)
	mu.Unlock()
	if req2 == nil {
		t.Fatal("no lead request captured for the follow-up turn")
	}
	// 要点是历史里的一条隐藏模型事件：系统提示与中止前保持一致。
	if instruction := llmRequestText(req2, true); instruction != llmRequestText(req1, true) {
		t.Fatalf("system instruction changed across turns:\n%s\n---\n%s", llmRequestText(req1, true), instruction)
	}
	// 请求内容里恰好出现一次、模型角色、位于"follow up"用户文本之前。
	noteAt, userAt, note := -1, -1, ""
	for i, c := range req2.Contents {
		if c == nil {
			continue
		}
		for _, p := range c.Parts {
			if p == nil {
				continue
			}
			if strings.Contains(p.Text, "Prior Fusion handoff") {
				if noteAt >= 0 {
					t.Fatalf("recovery note duplicated in request contents:\n%s", llmRequestText(req2, false))
				}
				if c.Role != genai.RoleModel {
					t.Fatalf("recovery note role = %q, want %q", c.Role, genai.RoleModel)
				}
				noteAt, note = i, p.Text
			}
			if c.Role == genai.RoleUser && strings.Contains(p.Text, "follow up") {
				userAt = i
			}
		}
	}
	if noteAt < 0 {
		t.Fatalf("recovery note missing from request contents:\n%s", llmRequestText(req2, false))
	}
	if userAt < 0 || noteAt > userAt {
		t.Fatalf("note at content %d, user message at %d:\n%s", noteAt, userAt, llmRequestText(req2, false))
	}
	for _, want := range []string{"recovery-task-marker", `"write"`, "state: interrupted"} {
		if !strings.Contains(note, want) {
			t.Fatalf("recovery note missing %q:\n%s", want, note)
		}
	}
	// 深路径要点保留文件名尾部：changed 行以落盘的文件名收尾。
	changedTail := false
	for _, line := range strings.Split(note, "\n") {
		if strings.HasPrefix(line, "changed: ") && strings.HasSuffix(line, `worker-output.txt"`) {
			changedTail = true
		}
	}
	if !changedTail {
		t.Fatalf("recovery note changed line lost the filename:\n%s", note)
	}
	// 追加成功即确认删除 pending 文件。
	if _, err := os.Stat(recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("recovery file still pending after append: %v", err)
	}
	// 原始会话历史里恰好一条隐藏要点事件，webHidden 与恢复标记可往返。
	sess, err := s.agent.Session(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	hidden := 0
	for ev := range sess.Events().All() {
		if ev == nil || ev.Content == nil {
			continue
		}
		matched := false
		for _, p := range ev.Content.Parts {
			if p != nil && strings.Contains(p.Text, "Prior Fusion handoff") {
				matched = true
			}
		}
		if !matched {
			continue
		}
		hidden++
		if ev.CustomMetadata["webHidden"] != true || ev.CustomMetadata["fusionRecovery"] != true {
			t.Fatalf("recovery event metadata = %v", ev.CustomMetadata)
		}
		if !strings.HasPrefix(ev.ID, "fusion-recovery-") || ev.Content.Role != genai.RoleModel {
			t.Fatalf("recovery event id=%q role=%q", ev.ID, ev.Content.Role)
		}
	}
	if hidden != 1 {
		t.Fatalf("hidden recovery events = %d, want 1", hidden)
	}
	code, env := call(t, ts, http.MethodGet,
		"/api/agent/history?workspaceHash="+main+"&sessionName="+name, key, nil)
	if code != http.StatusOK {
		t.Fatalf("history = %d %v", code, env)
	}
	if raw, _ := json.Marshal(env); strings.Contains(string(raw), "Prior Fusion handoff") {
		t.Fatal("recovery note leaked into the history API")
	}

	// 崩溃窗口重放：同一 pending 文件再次被读到时，稳定事件 ID 让
	// 追加去重而不是生成第二条要点，文件随后被确认删除。
	if err := repository.WriteFile(recoveryPath, pending); err != nil {
		t.Fatal(err)
	}
	fusionStream(t, ts, key, name, "again")
	waitReleased()
	var req3 *model.LLMRequest
	mu.Lock()
	if len(seen) > count {
		req3 = seen[count]
	}
	mu.Unlock()
	if req3 == nil {
		t.Fatal("no lead request captured for the third turn")
	}
	if instruction := llmRequestText(req3, true); instruction != llmRequestText(req1, true) {
		t.Fatalf("system instruction changed by the third turn:\n%s", instruction)
	}
	// 已提交的历史事件保留：第三轮内容以第二轮全部内容为前缀，且
	// 要点仍恰好出现一次。
	if !strings.HasPrefix(llmRequestText(req3, false), llmRequestText(req2, false)) {
		t.Fatalf("third-turn contents diverged:\n%s\n---\n%s", llmRequestText(req2, false), llmRequestText(req3, false))
	}
	notes := 0
	for _, c := range req3.Contents {
		if c == nil {
			continue
		}
		for _, p := range c.Parts {
			if p != nil && strings.Contains(p.Text, "Prior Fusion handoff") {
				notes++
			}
		}
	}
	if notes != 1 {
		t.Fatalf("replayed pending file produced %d notes", notes)
	}
	if _, err := os.Stat(recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("replayed recovery file not cleared: %v", err)
	}
}

// TestFusionRecoveryQuietTurnClearsNote 计划/需求/机器人共用的静默轮次
// 与 SSE 轮次一样把待确认要点追加为隐藏模型事件（用户文本之前、系统
// 提示不变），随后确认删除 pending 文件。
func TestFusionRecoveryQuietTurnClearsNote(t *testing.T) {
	var mu sync.Mutex
	var seen []*model.LLMRequest
	lead := fusionRecoveryLead{LLM: echo.New("quiet-lead", echo.Script{Text: "quiet reply"}), saw: func(req *model.LLMRequest) {
		mu.Lock()
		seen = append(seen, req)
		mu.Unlock()
	}}
	ts, key, s := fusionServer(t, lead, "http://127.0.0.1:9/v1", nil)
	main := s.agent.App()
	const name = "fusion-quiet"
	enableFusion(t, ts, key, main, name, "sidekick:side-model")
	view, err := s.prepareTurn(&chatRequest{SessionName: name})
	if err != nil {
		t.Fatal(err)
	}
	defer view.closeTurnTools()
	if view.subRunner == nil || view.subRunner.FusionScope == "" {
		t.Fatal("fusion runner missing scope")
	}
	recoveryPath := filepath.Join(s.subSessionsDir(name), ".fusion-recovery.json")
	if err := repository.WriteJSON(recoveryPath, map[string]any{
		"scope": view.subRunner.FusionScope, "task": "quiet-marker", "status": "aborted",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.runTurnQuiet(context.Background(), name, "follow up"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) == 0 {
		t.Fatal("no lead request captured for the quiet turn")
	}
	req := seen[0]
	if instruction := llmRequestText(req, true); strings.Contains(instruction, "Prior Fusion handoff") {
		t.Fatalf("quiet turn system instruction changed:\n%s", instruction)
	}
	// 要点作为隐藏模型事件进入请求内容，位于最新用户文本之前。
	noteAt, userAt := -1, -1
	for i, c := range req.Contents {
		if c == nil {
			continue
		}
		for _, p := range c.Parts {
			if p == nil {
				continue
			}
			if strings.Contains(p.Text, "Prior Fusion handoff") {
				if noteAt >= 0 {
					t.Fatal("recovery note duplicated in quiet request contents")
				}
				if c.Role != genai.RoleModel {
					t.Fatalf("recovery note role = %q, want %q", c.Role, genai.RoleModel)
				}
				for _, want := range []string{"quiet-marker", "state: interrupted"} {
					if !strings.Contains(p.Text, want) {
						t.Fatalf("quiet note missing %q:\n%s", want, p.Text)
					}
				}
				noteAt = i
			}
			if c.Role == genai.RoleUser && strings.Contains(p.Text, "follow up") {
				userAt = i
			}
		}
	}
	if noteAt < 0 || userAt < 0 || noteAt > userAt {
		t.Fatalf("note at content %d, user message at %d:\n%s", noteAt, userAt, llmRequestText(req, false))
	}
	if _, err := os.Stat(recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("recovery file still present after a clean quiet turn: %v", err)
	}
}

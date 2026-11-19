package controller

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// fusionServer 搭一个项目工作区：父模型用脚本 echo，可选的 sidekick
// 渠道指向本地 OpenAI 兼容端点，disabled 进 cfg.DisabledTools，
// extras 追加进父级工具注册表。
func fusionServer(t *testing.T, lead *echo.Scripted, sidekickBase string, disabled []string, extras ...tools.Tool) (*httptest.Server, string, *Controller) {
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
	a, err := agentpkg.New(t.TempDir(), "a1b2c3", &cfg, agentpkg.Options{
		Model:    lead,
		Toolsets: []tool.Toolset{reg},
	})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Registry: reg, Home: t.TempDir()})
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
// 没有 name 参数，也不接受选择执行模型。
func fusionDelegateCall(profile, task, instructions string) []*genai.FunctionCall {
	args := map[string]any{"profile": profile, "task": task}
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

func subStartIDs(events []map[string]any) []string {
	var out []string
	for _, e := range events {
		if e["type"] == "sub_start" {
			out = append(out, fmt.Sprint(e["subSessionId"]))
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
		echo.Script{ToolCalls: fusionDelegateCall("explore", "explore-fusion-brief", "explore-fusion-constraint")},
		echo.Script{ToolCalls: fusionDelegateCall("implement", "first-fusion-brief", "")},
		echo.Script{ToolCalls: fusionDelegateCall("test", "review-fusion-brief", "review-fusion-constraint")},
		echo.Script{Text: "第一轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("test", "followup-fusion-brief", "followup-fusion-constraint")},
		echo.Script{Text: "第二轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("implement", "other-fusion-brief", "")},
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

	turn1 := fusionStream(t, ts, key, name, "父会话第一条消息")
	turn2 := fusionStream(t, ts, key, name, "父会话第二条消息")
	enableFusion(t, ts, key, main, "fusion-other", "sidekick:side-model")
	turn3 := fusionStream(t, ts, key, "fusion-other", "另一个会话的消息")

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 5 {
		t.Fatalf("sidekick requests = %d", len(bodies))
	}
	for i, body := range bodies {
		var payload map[string]any
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatalf("request %d not json: %v", i, err)
		}
		if payload["model"] != "side-model" {
			t.Fatalf("request %d model = %v", i, payload["model"])
		}
	}
	// explore 委派只拿只读工具：rg/read 在，写工具、终端、委派与
	// 清单工具都不出现在执行代理的工具声明里。
	exploreBody := bodies[0]
	for _, want := range []string{`"name":"rg"`, `"name":"read"`} {
		if !strings.Contains(exploreBody, want) {
			t.Fatalf("explore handoff missing read-only tool %q\nbody: %s", want, exploreBody)
		}
	}
	for _, notWant := range []string{`"name":"edit"`, `"name":"write"`, fmt.Sprintf(`"name":"%s"`, shellenv.Current.Name), `"name":"fusion_delegate"`, `"name":"checklist_update"`} {
		if strings.Contains(exploreBody, notWant) {
			t.Fatalf("explore handoff leaked writable/meta tool %q", notWant)
		}
	}
	// 同轮实现委派看到调查结论，并拿回写工具。
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
	if got := len(subStartIDs(turn1)); got != 3 {
		t.Fatalf("turn 1 subStart count = %d, want 3", got)
	}
	// 首个委派（explore）的最终结果先于第二次子会话开始。
	exploreResultIndex, secondSubStart := -1, -1
	subStarts := 0
	for i, e := range turn1 {
		if e["type"] == "sub_start" {
			subStarts++
			if subStarts == 2 {
				secondSubStart = i
			}
		}
		if e["type"] == "tool_result" && e["name"] == fusionDelegateName && strings.Contains(fmt.Sprint(e["result"]), "explore-fusion-result") {
			exploreResultIndex = i
		}
	}
	if exploreResultIndex < 0 || secondSubStart < 0 || exploreResultIndex > secondSubStart {
		t.Fatalf("want explore result before second sub_start; events=%v", turn1)
	}
	ids := map[string]bool{}
	for _, evs := range [][]map[string]any{turn1, turn2, turn3} {
		for _, id := range subStartIDs(evs) {
			ids[id] = true
		}
	}
	if len(ids) != 5 {
		t.Fatalf("subSessionIds not distinct: %v", ids)
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
		echo.Script{ToolCalls: fusionDelegateCall("implement", "keep-fusion-brief", "")},
		echo.Script{Text: "第一轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("implement", "fail-fusion-brief", "")},
		echo.Script{Text: "第二轮失败已上报"},
		echo.Script{ToolCalls: fusionDelegateCall("implement", "third-fusion-brief", "")},
		echo.Script{Text: "第三轮完成"},
		echo.Script{ToolCalls: fusionDelegateCall("implement", "clean-fusion-brief", "")},
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
	var failedEnd string
	for _, e := range failed {
		if e["type"] == "sub_end" {
			failedEnd, _ = e["status"].(string)
		}
	}
	if failedEnd != "error" {
		t.Fatalf("failed handoff sub_end = %q; events=%v", failedEnd, failed)
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
// 按会话持久化、纯聊天与未知值被拒、关闭删键、且不进入引擎偏好。
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

	// 旧会话没有保存过选择：选项存在且为 off。
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+main+"&sessionName="+name, key, nil)
	if code != http.StatusOK {
		t.Fatalf("get config = %d %v", code, env)
	}
	opt := find(optionsOf(env), "fusionSidekick")
	if opt == nil || opt["currentValue"] != "off" {
		t.Fatalf("default fusion = %v", opt)
	}

	// 纯聊天工作区不暴露选项，写入同样被拒。
	code, env = call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+chatWorkspace+"&sessionName="+name, key, nil)
	if code != http.StatusOK {
		t.Fatalf("chat get config = %d %v", code, env)
	}
	if find(optionsOf(env), "fusionSidekick") != nil {
		t.Fatal("chat workspace exposes fusionSidekick")
	}
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": chatWorkspace, "sessionName": name, "configId": "fusionSidekick", "value": "off"})
	if code != http.StatusBadRequest {
		t.Fatalf("chat PUT fusion = %d %v", code, env)
	}

	// 不在目录中的组合值被拒。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "fusionSidekick", "value": "missing:model"})
	if code != http.StatusBadRequest {
		t.Fatalf("unknown fusion value = %d %v", code, env)
	}

	// 目录内组合值按会话持久化，未知 meta 键保留。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "fusionSidekick", "value": "default:deepseek-v4-flash"})
	if code != http.StatusOK {
		t.Fatalf("enable fusion = %d %v", code, env)
	}
	if opt = find(optionsOf(env), "fusionSidekick"); opt["currentValue"] != "default:deepseek-v4-flash" {
		t.Fatalf("fusion current = %v", opt["currentValue"])
	}
	meta := s.sessionMetaRead(name)
	if meta["fusionSidekick"] != "default:deepseek-v4-flash" || meta["futureField"] != "keep" {
		t.Fatalf("meta = %v", meta)
	}
	code, env = call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+main+"&sessionName=other", key, nil)
	if opt = find(optionsOf(env), "fusionSidekick"); opt == nil || opt["currentValue"] != "off" {
		t.Fatalf("other session fusion = %v", opt)
	}

	// Fusion 不写入引擎偏好；随后修改普通选项的快照也一样。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "effort", "value": "low"})
	if code != http.StatusOK {
		t.Fatalf("effort = %d %v", code, env)
	}
	agents, _ := s.enginePreferencesRead()["agents"].(map[string]any)
	native, _ := agents["native"].(map[string]any)
	if _, ok := native["fusionSidekick"]; ok {
		t.Fatalf("fusion leaked into preferences: %v", native)
	}
	if native["effort"] != "low" {
		t.Fatalf("preferences = %v", native)
	}

	// 关闭移除该键，其余 meta 字段不受影响。
	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": name, "configId": "fusionSidekick", "value": "off"})
	if code != http.StatusOK {
		t.Fatalf("disable fusion = %d %v", code, env)
	}
	meta = s.sessionMetaRead(name)
	if _, ok := meta["fusionSidekick"]; ok {
		t.Fatalf("meta still has fusion: %v", meta)
	}
	if meta["futureField"] != "keep" {
		t.Fatalf("meta lost futureField: %v", meta)
	}
}

// TestFusionSidekickRunsImplement 走完整聊天流：父代理委派 implement，
// 子代理改打本地 sidekick 渠道，执行文本经由 sub_* 与工具结果返回，
// 被禁用的工具不出现在执行模型的请求里。
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
		echo.Script{ToolCalls: fusionDelegateCall("implement", "实现登录页", "")},
		echo.Script{Text: "已亲自核对执行模型的改动，可以交付"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", []string{"write"})
	enableFusion(t, ts, key, s.agent.App(), "fusion-run", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-run", "实现登录页")
	types := eventTypes(events)
	for _, want := range []string{"sub_start", "sub_content", "sub_end", "complete"} {
		found := false
		for _, typ := range types {
			if typ == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q; events=%v", want, events)
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("sidekick requests = %d", requests.Load())
	}
	if gotModel.Load() != "side-model" {
		t.Fatalf("sidekick model = %v", gotModel.Load())
	}
	var subText, toolResult, subEnd, final, subSessionID string
	subStartIndex, subEndIndex, toolResultIndex, finalIndex := -1, -1, -1, -1
	planResultIndex := -1
	for i, e := range events {
		switch e["type"] {
		case "sub_start":
			subSessionID, _ = e["subSessionId"].(string)
			if subStartIndex < 0 {
				subStartIndex = i
			}
		case "sub_content":
			subText += fmt.Sprint(e["token"])
		case "sub_end":
			subEnd, _ = e["status"].(string)
			subEndIndex = i
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
		case "content":
			if finalIndex < 0 && fmt.Sprint(e["content"]) != "" {
				finalIndex = i
			}
			final += fmt.Sprint(e["content"])
		}
	}
	if subEnd != "completed" {
		t.Fatalf("sub_end status = %q; events=%v", subEnd, events)
	}
	if !strings.Contains(subText, "执行模型已完成实现") {
		t.Fatalf("sub_content = %q", subText)
	}
	if !strings.Contains(toolResult, "执行模型已完成实现") {
		t.Fatalf("fusion_delegate tool_result = %q", toolResult)
	}
	if !strings.Contains(final, "可以交付") {
		t.Fatalf("parent final = %q; events=%v", final, events)
	}
	// 同步委派：最终结果先回到 fusion_delegate，主代理再产出内容；
	// 不会出现 running/call_id 占位结果。
	if subEndIndex < 0 || toolResultIndex <= subEndIndex || finalIndex <= toolResultIndex {
		t.Fatalf("want sub_end before fusion_delegate result before lead content; events=%v", events)
	}
	// 先拆解再交接：计划成功的 tool_result 先于首个 sub_start。
	if planResultIndex < 0 || subStartIndex < 0 || planResultIndex > subStartIndex {
		t.Fatalf("want checklist_update result before first sub_start; events=%v", events)
	}
	// Fusion 执行记录持久化 resumable:false，回放面板据此不提供续聊。
	code, env := call(t, ts, http.MethodGet,
		"/api/sub-sessions?workspaceHash="+s.agent.App()+"&sessionName=fusion-run", key, nil)
	if code != http.StatusOK {
		t.Fatalf("sub-sessions = %d %v", code, env)
	}
	var subInfo map[string]any
	for _, item := range env["data"].([]any) {
		if dto := item.(map[string]any); dto["subSessionId"] == subSessionID {
			subInfo = dto
		}
	}
	if subInfo == nil || subInfo["resumable"] != false {
		t.Fatalf("fusion sub session resumable = %v (id=%q, list=%v)", subInfo, subSessionID, env["data"])
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
// schema 带 profile/task；普通 sub_agent 保持可让出的异步语义。
func TestFusionDelegateIsSynchronous(t *testing.T) {
	ts, key, s := fusionServer(t, echo.New("idle-lead"), "http://127.0.0.1:9/v1", nil)
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
	for _, want := range []string{`"profile"`, `"task"`} {
		if !strings.Contains(string(schema), want) {
			t.Fatalf("fusion_delegate schema %s missing %s", schema, want)
		}
	}
	if strings.Contains(string(schema), "yield_after_ms") {
		t.Fatalf("fusion_delegate schema must not yield: %s", schema)
	}
	check, ok := got[checklistUpdateName]
	if !ok || !check.Meta.ReadOnly || check.Meta.Async {
		t.Fatalf("checklist_update registration = %+v (found=%v)", check.Meta, ok)
	}
	if _, ok := got["fusion_plan"]; ok {
		t.Fatal("retired fusion_plan must not be advertised")
	}

	plain, err := s.prepareTurn(&chatRequest{SessionName: "plain-sync"})
	if err != nil {
		t.Fatal(err)
	}
	defer plain.closeTurnTools()
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
		echo.Script{ToolCalls: fusionDelegateCall("implement", "实现", "")},
		leadActive,
		echo.Script{ToolCalls: fusionDelegateCall("implement", "实现", "")},
		echo.Script{Text: "计划未就绪，委派被计划门卫拒绝"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	enableFusion(t, ts, key, s.agent.App(), "fusion-guard", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-guard", "实现")
	failed, subStarts := 0, 0
	for _, e := range events {
		switch e["type"] {
		case "sub_start":
			subStarts++
		case "tool_result":
			if n, _ := e["name"].(string); n == fusionDelegateName && e["status"] == "failed" {
				if !strings.Contains(fmt.Sprint(e["result"]), checklistUpdateName) {
					t.Fatalf("delegate failure should mention %s: %q", checklistUpdateName, e["result"])
				}
				failed++
			}
		}
	}
	if failed != 2 || subStarts != 0 {
		t.Fatalf("failed delegates = %d, sub_start = %d; events=%v", failed, subStarts, events)
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
		echo.Script{ToolCalls: fusionDelegateCall("implement", "first-brief", "")},
		echo.Script{ToolCalls: fusionDelegateCall("implement", "stale-brief", "")},
		echo.Script{Text: "第二项交接前需要刷新计划"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	enableFusion(t, ts, key, s.agent.App(), "fusion-fresh", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-fresh", "干活")
	subStarts, delegateOK, delegateFailed := 0, 0, 0
	for _, e := range events {
		switch e["type"] {
		case "sub_start":
			subStarts++
		case "tool_result":
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
	if delegateOK != 1 || delegateFailed != 1 || subStarts != 1 {
		t.Fatalf("delegates ok=%d failed=%d sub_start=%d; events=%v", delegateOK, delegateFailed, subStarts, events)
	}
	if requests.Load() != 1 {
		t.Fatalf("sidekick requests = %d, want 1 (first-brief only)", requests.Load())
	}
}

// TestFusionSidekickFailure 执行模型返回不可重试错误时，子代理按
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
		echo.Script{ToolCalls: fusionDelegateCall("implement", "实现", "")},
		echo.Script{Text: "执行模型失败，已如实上报"},
	)
	ts, key, s := fusionServer(t, scripted, upstream.URL+"/v1", nil)
	enableFusion(t, ts, key, s.agent.App(), "fusion-fail", "sidekick:side-model")

	events := fusionStream(t, ts, key, "fusion-fail", "实现")
	var subEnd, toolStatus, toolResult, final string
	for _, e := range events {
		switch e["type"] {
		case "sub_end":
			subEnd, _ = e["status"].(string)
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
	if subEnd != "error" {
		t.Fatalf("sub_end status = %q; events=%v", subEnd, events)
	}
	if toolStatus != "failed" || !strings.Contains(toolResult, "400") {
		t.Fatalf("fusion_delegate tool_result = %q %q; events=%v", toolStatus, toolResult, events)
	}
	if !strings.Contains(final, "已如实上报") {
		t.Fatalf("parent final = %q; events=%v", final, events)
	}
}

// TestFusionWorkerInheritsSessionApproval 会话级 hitl 覆盖经 StrictModel
// 透传给执行模型：全局 free + 会话 approval 时，worker 的非只读
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
		echo.Script{ToolCalls: fusionDelegateCall("implement", "干活", "")},
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

	// 会话 approval 模式下父代理的 sub_agent 调用本身先要审批。
	_, choice := readUntilEvent(t, scanner, "choice")
	approve(fmt.Sprint(choice["permissionRequestId"]))

	// 执行模型的非只读工具停在 sub_choice：审批前不得执行。
	_, subChoice := readUntilEvent(t, scanner, "sub_choice")
	if calls.Load() != 0 {
		t.Fatalf("fixture ran before approval; subChoice=%v", subChoice)
	}
	approve(fmt.Sprint(subChoice["permissionRequestId"]))

	events, _ := readUntilEvent(t, scanner, "done")
	if calls.Load() != 1 {
		t.Fatalf("fixture calls = %d; events=%v", calls.Load(), events)
	}
	if requests.Load() != 2 {
		t.Fatalf("sidekick requests = %d", requests.Load())
	}
	var subEnd string
	for _, e := range events {
		if e["type"] == "sub_end" {
			subEnd, _ = e["status"].(string)
		}
	}
	if subEnd != "completed" {
		t.Fatalf("sub_end = %q; events=%v", subEnd, events)
	}
}

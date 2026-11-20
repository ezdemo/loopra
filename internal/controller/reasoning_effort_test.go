package controller

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
)

// effortLevelsServer 提供两个不同强度目录的模型、一个显式空目录与
// 一个未配置目录的模型，外加强度目录独立的 sidekick 渠道。
func effortLevelsServer(t *testing.T) (*httptest.Server, string, *Controller, string) {
	t.Helper()
	ts, key, s, _ := parityServer(t, "")
	// 走配置服务的真实持久化路径：处理器读取的是配置快照。
	saved, err := s.configuration.Update(map[string]any{
		"model": "model-a", "modelChannelId": "default", "reasoningEffort": "high",
		"modelChannels": []config.Channel{
			{ID: "default", Name: "Default", Models: []config.ModelEntry{
				{Name: "model-a", ReasoningEfforts: []string{"low", "high"}},
				{Name: "model-b", ReasoningEfforts: []string{"minimal", "high"}},
				{Name: "silent", ReasoningEfforts: []string{}},
				{Name: "free"},
			}},
			{ID: "side", Name: "Side", Models: []config.ModelEntry{
				{Name: "side-model", ReasoningEfforts: []string{"minimal"}},
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s.cfg = saved
	return ts, key, s, s.agent.App()
}

func findConfigOption(list []any, id string) map[string]any {
	for _, item := range list {
		if option, ok := item.(map[string]any); ok && option["id"] == id {
			return option
		}
	}
	return nil
}

func optionValues(option map[string]any) []string {
	var out []string
	for _, item := range option["options"].([]any) {
		out = append(out, item.(map[string]any)["value"].(string))
	}
	return out
}

func nativeConfig(t *testing.T, ts *httptest.Server, key, workspace, session string) []any {
	t.Helper()
	code, env := call(t, ts, http.MethodGet, "/api/agent-engines/config?workspaceHash="+workspace+"&sessionName="+session, key, nil)
	if code != http.StatusOK {
		t.Fatalf("get config = %d %v", code, env)
	}
	return env["data"].(map[string]any)["configOptions"].([]any)
}

// Native /agent-engines/config 的强度选项随所选模型的目录变化：
// 有效已存值保留、失效值回退、空目录省略整个选项、未配置目录的
// 模型沿用内置目录并附带已存的自定义值。
func TestNativeEffortOptionsFollowModelLevels(t *testing.T) {
	ts, key, s, main := effortLevelsServer(t)

	s.sessionMetaSet("keep", map[string]any{"model": "model-a", "modelChannelId": "default", "reasoningEffort": "high"})
	effort := findConfigOption(nativeConfig(t, ts, key, main, "keep"), "effort")
	if effort == nil || !slices.Equal(optionValues(effort), []string{"low", "high"}) || effort["currentValue"] != "high" {
		t.Fatalf("keep effort = %v", effort)
	}

	s.sessionMetaSet("stale", map[string]any{"model": "model-a", "modelChannelId": "default", "reasoningEffort": "xhigh"})
	effort = findConfigOption(nativeConfig(t, ts, key, main, "stale"), "effort")
	if effort == nil || effort["currentValue"] != "high" {
		t.Fatalf("stale effort = %v", effort)
	}

	s.sessionMetaSet("quiet", map[string]any{"model": "silent", "modelChannelId": "default", "reasoningEffort": "high"})
	if findConfigOption(nativeConfig(t, ts, key, main, "quiet"), "effort") != nil {
		t.Fatal("explicit empty catalog should omit the effort option")
	}

	s.sessionMetaSet("custom", map[string]any{"model": "free", "modelChannelId": "default", "reasoningEffort": "Turbo"})
	effort = findConfigOption(nativeConfig(t, ts, key, main, "custom"), "effort")
	if effort == nil || !slices.Contains(optionValues(effort), "Turbo") || effort["currentValue"] != "Turbo" {
		t.Fatalf("legacy custom effort = %v", effort)
	}
}

// 通过引擎配置切换模型会刷新强度选项：仍受支持的强度保留，
// 空目录模型的响应里不再带 effort 选项。
func TestNativeModelSwitchRefreshesEffort(t *testing.T) {
	ts, key, s, main := effortLevelsServer(t)
	const session = "switcher"
	s.sessionMetaSet(session, map[string]any{"model": "model-b", "modelChannelId": "default", "reasoningEffort": "high"})

	code, env := call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": session, "configId": "model", "value": "default:model-a"})
	if code != http.StatusOK {
		t.Fatalf("switch model = %d %v", code, env)
	}
	effort := findConfigOption(env["data"].(map[string]any)["configOptions"].([]any), "effort")
	if effort == nil || !slices.Equal(optionValues(effort), []string{"low", "high"}) || effort["currentValue"] != "high" {
		t.Fatalf("effort after switch = %v", effort)
	}
	if got := s.sessionMetaRead(session)["reasoningEffort"]; got != "high" {
		t.Fatalf("persisted effort = %v", got)
	}

	code, env = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": session, "configId": "model", "value": "default:silent"})
	if code != http.StatusOK {
		t.Fatalf("switch silent = %d %v", code, env)
	}
	if findConfigOption(env["data"].(map[string]any)["configOptions"].([]any), "effort") != nil {
		t.Fatal("silent model should not advertise effort")
	}

	// 目录外的显式强度被 PUT 拒绝且不写 .meta。
	code, _ = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": session, "configId": "model", "value": "default:model-a"})
	if code != http.StatusOK {
		t.Fatalf("switch back = %d", code)
	}
	code, _ = call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": session, "configId": "effort", "value": "xhigh"})
	if code != http.StatusBadRequest {
		t.Fatalf("unsupported effort = %d", code)
	}
	if got := s.sessionMetaRead(session)["reasoningEffort"]; got == "xhigh" {
		t.Fatalf("rejected effort persisted: %v", got)
	}
}

// /sessions/{name}/settings 与选项目录使用同一套归一：显式请求
// 目录外强度返回 400 且不持久化，已存失效值只回退不报错，空目录
// 返回空字符串。
func TestSessionSettingsReasoningLevels(t *testing.T) {
	ts, key, s, _ := effortLevelsServer(t)
	const session = "settings-levels"

	s.sessionMetaSet(session, map[string]any{"model": "model-a", "modelChannelId": "default", "reasoningEffort": "xhigh"})
	code, env := call(t, ts, http.MethodGet, "/api/sessions/"+session+"/settings", key, nil)
	if code != http.StatusOK || env["data"].(map[string]any)["reasoningEffort"] != "high" {
		t.Fatalf("stale fallback = %d %v", code, env["data"])
	}

	code, _ = call(t, ts, http.MethodPut, "/api/sessions/"+session+"/settings", key,
		map[string]any{"reasoningEffort": "xhigh"})
	if code != http.StatusBadRequest {
		t.Fatalf("explicit unsupported = %d", code)
	}
	if got := s.sessionMetaRead(session)["reasoningEffort"]; got != "high" {
		t.Fatalf("rejected request wrote meta: %v", got)
	}

	s.sessionMetaSet(session, map[string]any{"model": "silent", "modelChannelId": "default"})
	code, env = call(t, ts, http.MethodGet, "/api/sessions/"+session+"/settings", key, nil)
	if code != http.StatusOK || env["data"].(map[string]any)["reasoningEffort"] != "" {
		t.Fatalf("empty catalog = %d %v", code, env["data"])
	}
}

// Fusion 的推理强度独立于主模型目录：跟随所选执行模型的配置，
// 目录外取值被拒，失效的已存值回退为 default，编辑不轮换 epoch。
func TestFusionEffortFollowsSidekickLevels(t *testing.T) {
	ts, key, s, main := effortLevelsServer(t)
	const session = "fusion-levels"

	enableFusion(t, ts, key, main, session, "side:side-model")
	options := nativeConfig(t, ts, key, main, session)
	fusion := findConfigOption(options, fusionEffortOption)
	if fusion == nil || !slices.Equal(optionValues(fusion), []string{"default", "minimal"}) {
		t.Fatalf("fusion effort options = %v", fusion)
	}

	code, _ := call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": session, "configId": fusionEffortOption, "value": "high"})
	if code != http.StatusBadRequest {
		t.Fatalf("sidekick-unsupported effort = %d", code)
	}

	epoch, _ := s.sessionMetaRead(session)[fusionEpochKey].(string)
	code, env := call(t, ts, http.MethodPut, "/api/agent-engines/config", key,
		map[string]any{"workspaceHash": main, "sessionName": session, "configId": fusionEffortOption, "value": "minimal"})
	if code != http.StatusOK {
		t.Fatalf("fusion effort = %d %v", code, env)
	}
	if got, _ := s.sessionMetaRead(session)[fusionEpochKey].(string); got != epoch {
		t.Fatal("effort edit rotated the fusion epoch")
	}
	if got := s.sessionMetaRead(session)[fusionEffortOption]; got != "minimal" {
		t.Fatalf("fusion effort meta = %v", got)
	}

	// 换到目录不含 minimal 的执行模型后，已存强度回退为 default。
	enableFusion(t, ts, key, main, session, "default:model-a")
	if got := s.sessionMetaRead(session)[fusionEffortOption]; got != fusionDefaultEffort {
		t.Fatalf("stale fusion effort = %v", got)
	}
	fusion = findConfigOption(nativeConfig(t, ts, key, main, session), fusionEffortOption)
	if fusion["currentValue"] != fusionDefaultEffort || !slices.Equal(optionValues(fusion), []string{"default", "low", "high"}) {
		t.Fatalf("fusion after model switch = %v", fusion)
	}
}

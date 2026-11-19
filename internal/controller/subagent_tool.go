package controller

import (
	"context"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/service/subagent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// sinkKey 通过请求上下文传递实时 SSE sink，
// 使 sub_agent 工具能把 sub_* 事件转发到父流。
type sinkKey struct{}

type ctxSink struct{ s *sseWriter }

func (c ctxSink) SendSub(event string, payload map[string]any) {
	c.s.send(event, payload)
}

// sinkFromContext 取出当前生效的子事件 sink（静默时为 nil）。
func sinkFromContext(ctx context.Context) subagent.Sink {
	if s, ok := ctx.Value(sinkKey{}).(*sseWriter); ok {
		return ctxSink{s: s}
	}
	return nil
}

// subAgentToolDescription 对应 Java 工具描述。
const subAgentToolDescription = `派生一个带预设角色的隔离子代理，完成后将结果返回给主代理。
可用角色: explore（只读项目探索）, implement（实现）, test（测试）, review（只读项目审查）, plan（只读项目方案）。
参数: name(必传), profile(必传), task(必传), instructions(可选)。
注意：explore/review/plan 只能使用只读项目工具；子代理不可再创建子代理。`

// fusionDelegateName 是 Fusion 专用委派工具名。它只在开启 Fusion 的
// 原生项目轮次注册，且子代理的硬性拒绝列表会挡住它被下级看到。
const fusionDelegateName = "fusion_delegate"

const fusionDelegateDescription = `把明确的实现、测试或评审反馈同步交给当前会话的 Fusion 执行代理。先调用 checklist_update，把本次 Sidekick 步骤标为 active；每次只交接这一步。参数：profile（implement 或 test）、task（任务）、instructions（可选约束）。它会延续此前成功交接的上下文；本调用等待最终结果，期间实时显示进度。`

type fusionDelegateArgs struct {
	Profile      string `json:"profile" jsonschema:"执行角色：implement 或 test"`
	Task         string `json:"task" jsonschema:"本次任务及验收条件"`
	Instructions string `json:"instructions,omitempty" jsonschema:"可选补充指示"`
}

// newSubAgentTool 构造绑定到单个 runner 的 sub_agent 工具。
// 父会话名通过请求上下文（sessionKey）传入。
type sessionKey struct{}

// subAgentParent 从请求上下文取父会话名（静默调用退化为 default）。
func subAgentParent(ctx context.Context) string {
	if v, ok := ctx.Value(sessionKey{}).(string); ok && v != "" {
		return v
	}
	return "default"
}

// subAgentToolResult 把一次子代理结果映射成工具返回值；
// 失败时以纯文本回传错误并保留可回放的 subSessionId。
func subAgentToolResult(res subagent.Result, err error) map[string]any {
	if err != nil {
		// Java 工具以纯文本返回校验失败。
		result := map[string]any{"result": err.Error(), "status": "failed"}
		if res.SubSessionID != "" {
			result["subSessionId"] = res.SubSessionID
		}
		return result
	}
	return map[string]any{
		"result": res.Reply, "status": res.Status, "subSessionId": res.SubSessionID,
	}
}

func (s *Controller) newSubAgentTool() tool.Tool {
	t, _ := functiontool.New[struct {
		Name         string `json:"name" jsonschema:"子代理显示名"`
		Profile      string `json:"profile" jsonschema:"角色: explore/implement/test/review/plan 或自定义 id"`
		Task         string `json:"task" jsonschema:"要完成的任务描述"`
		Instructions string `json:"instructions,omitempty" jsonschema:"可选补充指示"`
	}, map[string]any](functiontool.Config{
		Name: "sub_agent", Description: subAgentToolDescription,
	}, func(ctx agentctx.Context, in struct {
		Name         string `json:"name" jsonschema:"子代理显示名"`
		Profile      string `json:"profile" jsonschema:"角色: explore/implement/test/review/plan 或自定义 id"`
		Task         string `json:"task" jsonschema:"要完成的任务描述"`
		Instructions string `json:"instructions,omitempty" jsonschema:"可选补充指示"`
	}) (map[string]any, error) {
		res, err := s.subRunner.Run(tools.WithChildFileChanges(ctx), subAgentParent(ctx), in.Name, in.Profile, in.Task, in.Instructions, sinkFromContext(ctx))
		return subAgentToolResult(res, err), nil
	})
	return t
}

// newFusionDelegateTool 构造同步的 Fusion 委派工具：无 Async 元数据，
// 调用方在拿到最终结果前不会继续主代理循环。gate 是本轮的委派门卫，
// 未把 Sidekick 步骤标为 active 时委派直接失败。
func (s *Controller) newFusionDelegateTool(gate *fusionDelegationState) tool.Tool {
	t, _ := functiontool.New[fusionDelegateArgs, map[string]any](functiontool.Config{
		Name: fusionDelegateName, Description: fusionDelegateDescription,
	}, func(ctx agentctx.Context, in fusionDelegateArgs) (map[string]any, error) {
		if err := gate.beginDelegation(); err != nil {
			return subAgentToolResult(subagent.Result{}, err), nil
		}
		defer gate.endDelegation()
		res, err := s.subRunner.RunFusion(tools.WithChildFileChanges(ctx), subAgentParent(ctx), in.Profile, in.Task, in.Instructions, sinkFromContext(ctx))
		return subAgentToolResult(res, err), nil
	})
	return t
}

package controller

import (
	"context"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/service/subagent"
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

// newSubAgentTool 构造绑定到单个 runner 的 sub_agent 工具。
// 父会话名通过请求上下文（sessionKey）传入。
type sessionKey struct{}

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
		parent := "default"
		if v, ok := ctx.Value(sessionKey{}).(string); ok && v != "" {
			parent = v
		}
		res, err := s.subRunner.Run(ctx, parent, in.Name, in.Profile, in.Task, in.Instructions, sinkFromContext(ctx))
		if err != nil {
			// Java 工具以纯文本返回校验失败。
			return map[string]any{"result": err.Error(), "status": "failed"}, nil
		}
		return map[string]any{
			"result": res.Reply, "status": res.Status, "subSessionId": res.SubSessionID,
		}, nil
	})
	return t
}

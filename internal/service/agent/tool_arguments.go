package agent

import (
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"

	"github.com/ezdemo/looprax/adk/model/provider"
)

type toolArgumentKey struct{ id, name string }

// Tool contexts do not expose Session(). Retain failures from the final model
// response until dispatch; scope them to this invocation and model step.
func (h *hookBridge) rememberToolArgumentErrors(ctx agent.Context, resp *model.LLMResponse) {
	if ctx == nil {
		return
	}
	errors := map[toolArgumentKey]string{}
	if resp.Content != nil {
		for _, part := range resp.Content.Parts {
			if message := provider.ToolArgumentError(part); message != "" {
				call := part.FunctionCall
				errors[toolArgumentKey{call.ID, call.Name}] = message
			}
		}
	}
	if len(errors) == 0 {
		h.argumentErrors.Delete(ctx.InvocationID())
	} else {
		h.argumentErrors.Store(ctx.InvocationID(), errors)
	}
}

func (h *hookBridge) toolArgumentFailure(ctx agent.Context, name string) string {
	value, ok := h.argumentErrors.Load(ctx.InvocationID())
	if !ok {
		return ""
	}
	return value.(map[toolArgumentKey]string)[toolArgumentKey{ctx.FunctionCallID(), name}]
}

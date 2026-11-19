package controller

import (
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/service/subagent"
)

// checklistUpdateName 是原生项目轮次内的待办清单工具；清单只存在工具
// 调用与结果里（JSONL 照常回放），不另建持久化文件或 SSE 事件。旧会话
// 里的 fusion_plan 仅作历史回放，不再注册。
const checklistUpdateName = "checklist_update"

const checklistUpdated = "待办清单已更新"

const checklistUpdateDescription = `为多步骤实现、调试或验证建立与更新本轮待办清单。每次提交完整 steps：description 写具体事项（不要在事项里重复写负责人），status 为 pending、active 或 done，最多一个 active。默认由主代理负责，owner 可省略；Fusion 模式下可用 owner: sidekick 标记执行代理负责的步骤。简单问答无需建清单。`

type checklistStep struct {
	Description string `json:"description"`
	Owner       string `json:"owner,omitempty"`
	Status      string `json:"status"`
}

type checklistInput struct {
	Steps []checklistStep `json:"steps"`
}

// activeOwner 校验整份清单并返回 active 步骤的负责人；非 Fusion 轮次
// 不允许出现 sidekick 步骤。
func (in checklistInput) activeOwner(fusion bool) (string, error) {
	if len(in.Steps) == 0 || len(in.Steps) > 12 {
		return "", fmt.Errorf("待办清单需要 1 到 12 个步骤")
	}
	active := ""
	for _, step := range in.Steps {
		text := strings.TrimSpace(step.Description)
		if text == "" || utf8.RuneCountInString(text) > 240 {
			return "", fmt.Errorf("待办清单的步骤说明需要 1 到 240 个字符")
		}
		owner := step.Owner
		if owner == "" {
			owner = "lead"
		}
		if owner != "lead" && (owner != "sidekick" || !fusion) {
			return "", fmt.Errorf("负责人可省略或设为 lead；仅 Fusion 模式可设为 sidekick")
		}
		switch step.Status {
		case "pending", "done":
		case "active":
			if active != "" {
				return "", fmt.Errorf("待办清单最多只能有一个进行中的步骤")
			}
			active = owner
		default:
			return "", fmt.Errorf("待办清单的状态必须是 pending、active 或 done")
		}
	}
	return active, nil
}

// fusionDelegationState 是单个 Fusion 轮次的委派门卫：委派前必须有一
// 个被标为 active 的 Sidekick 步骤，每次清单更新只授权一次交接，委派进
// 行中不允许改写清单。状态随轮次 Runner 一起销毁。
type fusionDelegationState struct {
	mu          sync.Mutex
	activeOwner string
	delegating  bool
}

func (p *fusionDelegationState) recordPlan(activeOwner string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.delegating {
		return fmt.Errorf("请等当前 Fusion 委派结束后再更新待办清单")
	}
	p.activeOwner = activeOwner
	return nil
}

func (p *fusionDelegationState) beginDelegation() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.delegating {
		return fmt.Errorf("请等待当前 Fusion 委派结束")
	}
	if p.activeOwner != "sidekick" {
		return fmt.Errorf("请先调用 checklist_update 更新待办清单，并把本次 Sidekick 步骤标为 active")
	}
	// 每轮计划更新只授权一次交接；重试或继续时先同步计划。
	p.activeOwner = ""
	p.delegating = true
	return nil
}

func (p *fusionDelegationState) endDelegation() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.delegating = false
}

func newChecklistUpdateTool(fusion *fusionDelegationState) tool.Tool {
	t, _ := functiontool.New[checklistInput, map[string]any](functiontool.Config{
		Name: checklistUpdateName, Description: checklistUpdateDescription,
	}, func(_ agentctx.Context, in checklistInput) (map[string]any, error) {
		activeOwner, err := in.activeOwner(fusion != nil)
		if err == nil && fusion != nil {
			err = fusion.recordPlan(activeOwner)
		}
		if err != nil {
			return subAgentToolResult(subagent.Result{}, err), nil
		}
		return map[string]any{"result": checklistUpdated}, nil
	})
	return t
}

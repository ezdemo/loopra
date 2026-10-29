package controller

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type planInput struct {
	Steps   string `json:"steps"`
	Summary string `json:"summary,omitempty"`
	Risks   string `json:"risks,omitempty"`
}
type choiceInput struct {
	Question    string `json:"question"`
	Options     []any  `json:"options"`
	AllowCustom bool   `json:"allowCustom,omitempty"`
}

func (s *Controller) installControlTools() {
	if s.registry == nil {
		return
	}
	plan, _ := functiontool.New[planInput, map[string]any](functiontool.Config{Name: "submit_plan", Description: "计划模式下提交有序执行步骤供用户审查。steps 可以是 JSON 字符串数组或每行一步的文本。"}, func(ctx agentctx.Context, in planInput) (map[string]any, error) {
		if s.sessionMetaRead(ctx.SessionID())["planMode"] != true {
			return nil, fmt.Errorf("当前不在计划模式")
		}
		var steps []string
		if json.Unmarshal([]byte(in.Steps), &steps) != nil {
			steps = strings.Split(in.Steps, "\n")
		}
		var text strings.Builder
		if strings.TrimSpace(in.Summary) != "" {
			fmt.Fprintf(&text, "**概述**：%s\n\n", strings.TrimSpace(in.Summary))
		}
		text.WriteString("**执行步骤**：\n")
		count := 0
		for _, step := range steps {
			step = strings.TrimSpace(step)
			if step == "" {
				continue
			}
			count++
			fmt.Fprintf(&text, "%d. %s\n", count, step)
		}
		if count == 0 {
			return nil, fmt.Errorf("执行步骤不能为空")
		}
		if strings.TrimSpace(in.Risks) != "" {
			fmt.Fprintf(&text, "\n**风险与注意事项**：%s\n", strings.TrimSpace(in.Risks))
		}
		s.sessionMetaSet(ctx.SessionID(), map[string]any{"pendingPlan": text.String()})
		if sink := sinkFromContext(ctx); sink != nil {
			sink.SendSub("plan_submitted", map[string]any{"plan": text.String()})
		}
		return map[string]any{"status": "submitted", "message": "计划已提交，等待用户确认。请结束本轮，不要执行修改操作。"}, nil
	})
	s.registry.Add(tools.Tool{Tool: plan, Meta: tools.Metadata{Name: "submit_plan", Description: plan.Description(), ReadOnly: true, AutoApprove: true}})
	choice, _ := functiontool.New[choiceInput, map[string]any](functiontool.Config{Name: "ask_choice", Description: "向用户展示选择菜单并结束本轮。"}, func(ctx agentctx.Context, in choiceInput) (map[string]any, error) {
		options := []map[string]any{}
		for _, item := range in.Options {
			if m, ok := item.(map[string]any); ok {
				if m["title"] == nil {
					m["title"] = m["label"]
				}
				options = append(options, m)
			} else {
				options = append(options, map[string]any{"title": fmt.Sprint(item)})
			}
		}
		if sink := sinkFromContext(ctx); sink != nil {
			sink.SendSub("choice", map[string]any{"title": in.Question, "options": options, "allowCustom": in.AllowCustom})
		}
		ctx.Actions().Escalate = true
		ctx.Actions().SkipSummarization = true
		return map[string]any{"result": "等待用户选择"}, nil
	})
	s.registry.Add(tools.Tool{Tool: choice, Meta: tools.Metadata{Name: "ask_choice", Description: choice.Description(), ReadOnly: true, AutoApprove: true}})
	s.installRequirementTools()
	s.installSkillTools()
	s.registry.SetFilter(func(ctx agentctx.ReadonlyContext, meta tools.Metadata) bool {
		if ctx == nil {
			return true
		}
		return s.sessionMetaRead(ctx.SessionID())["planMode"] != true || meta.ReadOnly || meta.Name == "ask_choice" || meta.Name == "submit_plan"
	})
}

type finishRequirementInput struct {
	Status  string `json:"status"`
	Summary string `json:"summary"`
}
type replyRequirementInput struct {
	Reply string `json:"reply"`
}

func (s *Controller) requirementForTool(ctx agentctx.Context) (model.Requirement, error) {
	name := ctx.SessionID()
	if !strings.HasPrefix(name, "req_") {
		return model.Requirement{}, fmt.Errorf("SCOPE_ONLY: 仅需求执行会话可用")
	}
	item, _, ok := s.requirementByID(strings.TrimPrefix(name, "req_"))
	if !ok || item.ProjectHash != s.agent.App() {
		return model.Requirement{}, fmt.Errorf("需求不存在")
	}
	return item, nil
}

func (s *Controller) installRequirementTools() {
	finish, _ := functiontool.New[finishRequirementInput, map[string]any](functiontool.Config{Name: "finish_requirement", Description: "声明当前需求结果。status 为 done 或 failed，summary 为执行总结。仅需求会话可用。"}, func(ctx agentctx.Context, in finishRequirementInput) (map[string]any, error) {
		item, err := s.requirementForTool(ctx)
		if err != nil {
			return nil, err
		}
		if in.Status != "done" && in.Status != "failed" {
			return nil, fmt.Errorf("INVALID_STATUS: status 必须是 done 或 failed")
		}
		s.requirementsMutate(item.ID, func(req *model.Requirement) {
			req.Status = in.Status
			req.Summary = in.Summary
			req.ApprovalPending = false
			req.UpdatedAt = time.Now().UnixMilli()
		})
		ctx.Actions().Escalate = true
		ctx.Actions().SkipSummarization = true
		return map[string]any{"result": "REQUIREMENT_FINISHED: " + in.Status + "，总结已记录"}, nil
	})
	s.registry.Add(tools.Tool{Tool: finish, Meta: tools.Metadata{Name: finish.Name(), Description: finish.Description(), ReadOnly: true, AutoApprove: true}})
	reply, _ := functiontool.New[replyRequirementInput, map[string]any](functiontool.Config{Name: "reply_requirement_comment", Description: "回复当前需求的用户评论，仅需求会话可用。"}, func(ctx agentctx.Context, in replyRequirementInput) (map[string]any, error) {
		item, err := s.requirementForTool(ctx)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(in.Reply) == "" {
			return nil, fmt.Errorf("EMPTY_REPLY: 回复内容不能为空")
		}
		sess, err := s.agent.Session(ctx, item.SessionName)
		if err != nil {
			return nil, err
		}
		event := &session.Event{Author: "model", Timestamp: time.Now(), Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: strings.TrimSpace(in.Reply)}}}}
		if err := s.agent.Sessions.AppendEvent(ctx, sess, event); err != nil {
			return nil, err
		}
		return map[string]any{"result": "REPLY_SENT: 回复已写入评论区"}, nil
	})
	s.registry.Add(tools.Tool{Tool: reply, Meta: tools.Metadata{Name: reply.Name(), Description: reply.Description(), ReadOnly: true, AutoApprove: true}})
	show, _ := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "show_requirements", Description: "查看当前需求及最近用户评论，仅需求会话可用。"}, func(ctx agentctx.Context, _ struct{}) (map[string]any, error) {
		item, err := s.requirementForTool(ctx)
		if err != nil {
			return nil, err
		}
		comments := []map[string]any{}
		for _, row := range s.sessionMessages(ctx, item.SessionName) {
			if row["role"] == "user" {
				comments = append(comments, row)
			}
		}
		if len(comments) > 20 {
			comments = comments[len(comments)-20:]
		}
		return map[string]any{"requirement": item, "comments": comments}, nil
	})
	s.registry.Add(tools.Tool{Tool: show, Meta: tools.Metadata{Name: show.Name(), Description: show.Description(), ReadOnly: true, AutoApprove: true}})
}

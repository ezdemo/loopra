package controller

import (
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

type choiceInput struct {
	Question    string `json:"question"`
	Options     []any  `json:"options"`
	AllowCustom bool   `json:"allowCustom,omitempty"`
}

func (s *Controller) installControlTools() {
	if s.registry == nil {
		return
	}
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
}

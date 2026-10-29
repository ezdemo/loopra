package controller

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

// appendUserMessage 向会话写入一个用户轮次，且不运行
// 智能体（对应 Java AgentService.appendUserMessage）。
func (s *Controller) appendUserMessage(ctx context.Context, sessionName, text string) error {
	sess, err := s.agent.Session(ctx, sessionName)
	if err != nil {
		return err
	}
	ev := &session.Event{
		Author: "user", Timestamp: time.Now(),
		Content: &genai.Content{Role: "user", Parts: []*genai.Part{{Text: text}}},
	}
	return s.agent.Sessions.AppendEvent(ctx, sess, ev)
}

// runTurnQuiet 驱动一个轮次并收集最终的助手文本。因工具审批而
// 暂停的轮次会等待权限端点完成裁决；
// 需求审批路径驱动同一个注册表。
func (s *Controller) runTurnQuiet(ctx context.Context, sessionName, message string) (string, error) {
	req := &chatRequest{SessionName: sessionName, Message: message}
	job, err := s.admitChat(req)
	if err != nil {
		return "", err
	}
	defer s.releaseChat(job)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	job.setCancel(cancel)
	select {
	case s.state.workers <- struct{}{}:
		defer func() { <-s.state.workers }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	view, err := s.prepareTurn(req)
	if err != nil {
		return "", err
	}
	s = view
	s.state.mu.Lock()
	job.runtime = s
	s.state.mu.Unlock()
	defer s.closeTurnTools()
	ctx = context.WithValue(ctx, sessionKey{}, sessionName)
	if gitops.IsRepo(s.workspaceRoot()) {
		msgID := newMsgID()
		if snap, err := gitops.Checkpoint(s.workspaceRoot(), msgID); err == nil {
			if err := s.recordSnapshot(sessionName, s.workspaceRoot(), snap); err == nil {
				ctx = withTurnSnapshot(ctx, msgID)
			}
		}
	}
	sess, err := s.agent.Session(ctx, sessionName)
	if err != nil {
		return "", err
	}
	content := &genai.Content{
		Role: "user", Parts: []*genai.Part{{Text: message}},
	}
	var reply string
	for {
		pendings, err := s.quietTurn(ctx, sess, content, &reply)
		if err != nil {
			return reply, err
		}
		if len(pendings) == 0 {
			return reply, nil
		}
		s.markApprovalPending(sessionName, len(pendings) > 0)
		responses := make([]*genai.Part, 0, len(pendings))
		for _, p := range pendings {
			option, ok := p.Wait(ctx)
			if !ok {
				s.permissions.CancelOne(p.ID)
				return reply, fmt.Errorf("审批等待被中断")
			}
			responses = append(responses, confirmationResponsePart(p.ConfirmID, option == "allow_once"))
		}
		s.markApprovalPending(sessionName, false)
		content = &genai.Content{Role: genai.RoleUser, Parts: responses}
	}
}

// quietTurn 静默消费一次 ADK 运行（不使用 SSE），收集最终的
// 助手文本以及该轮次暂停时产生的审批请求。
func (s *Controller) quietTurn(ctx context.Context, sess session.Session, content *genai.Content, reply *string) ([]*hitl.Request, error) {
	var pendings []*hitl.Request
	for ev, err := range s.agent.Run(ctx, sess, content) {
		if err != nil {
			return pendings, err
		}
		if ev.Partial || ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName {
				if req := s.registerConfirmation(sess.ID(), p.FunctionCall); req != nil {
					pendings = append(pendings, req)
				}
			}
		}
		if ev.Content.Role == "model" {
			for _, p := range ev.Content.Parts {
				if p.Text != "" && !p.Thought {
					*reply = p.Text
				}
			}
		}
	}
	return pendings, nil
}

// markApprovalPending 将实时的待审批状态同步到本会话对应的
// 需求上（若存在）。
func (s *Controller) markApprovalPending(sessionName string, pending bool) {
	s.reqs.MarkPending(sessionName, pending)
}

// sessionMessages 以 {role, content} 行的形式读取会话历史。
func (s *Controller) sessionMessages(ctx context.Context, name string) []map[string]any {
	return s.sessionFiles().Messages(name)
}

package agent

import (
	"context"
	"fmt"
	"iter"
	"strings"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/compaction"
	"google.golang.org/genai"
)

func isCompactCommand(msg *genai.Content) bool {
	return msg != nil && msg.Role == genai.RoleUser && len(msg.Parts) == 1 &&
		msg.Parts[0] != nil && !msg.Parts[0].Thought && strings.TrimSpace(msg.Parts[0].Text) == "/compact"
}

// 手动压缩仍由 ADK 选择安全窗口并追加检查点；仅跳过 token 阈值。
// 独立 runner 的回调负责命令反馈，避免向模型发送 /compact 或执行工具。
func (a *Agent) runCompact(ctx context.Context, sess session.Session, msg *genai.Content) iter.Seq2[*session.Event, error] {
	return func(yield func(*session.Event, error) bool) {
		if a.context.Compaction() == nil {
			yield(nil, fmt.Errorf("上下文压缩已关闭"))
			return
		}
		summarizer := &commandSummarizer{Summarizer: a.context}
		sessions := &commandSessions{Service: a.context.SessionService(a.Sessions, a.cfg)}
		root, err := llmagent.New(llmagent.Config{
			Name: a.Root.Name(), Model: a.Model,
			BeforeModelCallbacks: []llmagent.BeforeModelCallback{
				func(ctx adkagent.Context, _ *model.LLMRequest) (*model.LLMResponse, error) {
					if err := ctx.Err(); err != nil {
						return nil, err
					}
					if summarizer.err != nil {
						return nil, fmt.Errorf("上下文压缩失败: %w", summarizer.err)
					}
					if sessions.err != nil {
						return nil, fmt.Errorf("保存压缩结果失败: %w", sessions.err)
					}
					reply := "没有可压缩的历史消息，已保留最近消息。"
					if sessions.compacted {
						reply = "上下文已压缩，最近消息和原始记录已保留。"
					} else if summarizer.attempted {
						// ADK 自动压缩会降级继续；显式命令必须反馈未落盘的结果。
						return nil, fmt.Errorf("上下文压缩未完成，摘要未保存，请重试")
					}
					return &model.LLMResponse{
						Content:      genai.NewContentFromText(reply, genai.RoleModel),
						TurnComplete: true, FinishReason: genai.FinishReasonStop,
					}, nil
				},
			},
		})
		if err != nil {
			yield(nil, err)
			return
		}
		policy := *a.context.Compaction()
		policy.TokenThreshold = 1
		policy.Summarizer = summarizer
		run, err := runner.New(runner.Config{
			AppName: a.app, Agent: root,
			SessionService: sessions,
			Compaction:     &policy,
		})
		if err != nil {
			yield(nil, err)
			return
		}
		for event, err := range run.Run(ctx, a.user, sess.ID(), msg, adkagent.RunConfig{StreamingMode: adkagent.StreamingModeSSE}) {
			if !yield(event, err) {
				return
			}
		}
	}
}

type commandSummarizer struct {
	compaction.Summarizer
	attempted bool
	err       error
}

func (s *commandSummarizer) SummarizeEvents(ctx context.Context, events []*session.Event) (compaction.SummarizeResult, error) {
	s.attempted = true
	result, err := s.Summarizer.SummarizeEvents(ctx, events)
	s.err = err
	return result, err
}

type commandSessions struct {
	session.Service
	compacted bool
	err       error
}

func (s *commandSessions) AppendEvent(ctx context.Context, current session.Session, event *session.Event) error {
	err := s.Service.AppendEvent(ctx, current, event)
	if event != nil && event.Actions.Compaction != nil {
		if err != nil {
			s.err = err
		} else {
			s.compacted = true
		}
	}
	return err
}

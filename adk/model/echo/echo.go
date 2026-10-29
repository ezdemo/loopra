// Package echo 提供脚本化的 model.LLM 实现，用于测试，以及
// 上层模块的离线冒烟运行，无需网络。
package echo

import (
	"context"
	"iter"
	"strings"
	"sync/atomic"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

// Script 是一条预先编排的模型响应。
type Script struct {
	// Text 是本轮次可见的内容。
	Text string
	// Thought 非空时会成为开头的推理部分。
	Thought string
	// ToolCalls 与 Text 一同发出（模型侧调用）。
	ToolCalls []*genai.FunctionCall
	// Deltas 在流式传输时把 Text 拆成多个分块；为空时
	// 整个 Text 作为一个分块。
	Deltas []string
}

// Usage 是每条脚本化响应都会上报的固定用量。
var Usage = &genai.GenerateContentResponseUsageMetadata{
	PromptTokenCount:     11,
	CandidatesTokenCount: 7,
	TotalTokenCount:      18,
}

// Scripted 重放固定的响应脚本，每次 GenerateContent 调用
// 前进一条。它可安全并发使用。
type Scripted struct {
	name   string
	script []Script
	next   atomic.Int64
}

// New 构建脚本化模型。没有脚本条目时，每次调用都会回显
// 最后一条用户文本。
func New(name string, script ...Script) *Scripted {
	return &Scripted{name: name, script: script}
}

// Name 实现 model.LLM。
func (m *Scripted) Name() string {
	if m.name == "" {
		return "echo-scripted"
	}
	return m.name
}

// GenerateContent 实现 model.LLM。
func (m *Scripted) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		var turn Script
		if len(m.script) == 0 {
			turn.Text = lastUserText(req)
		} else {
			idx := m.next.Add(1) - 1
			turn = m.script[idx%int64(len(m.script))]
		}
		parts := make([]*genai.Part, 0, 2+len(turn.ToolCalls))
		if turn.Thought != "" {
			parts = append(parts, &genai.Part{Text: turn.Thought, Thought: true})
		}
		if turn.Text != "" {
			parts = append(parts, &genai.Part{Text: turn.Text})
		}
		for _, fc := range turn.ToolCalls {
			parts = append(parts, &genai.Part{FunctionCall: fc})
		}
		if stream {
			for _, delta := range splitDeltas(turn.Thought) {
				if delta == "" {
					continue
				}
				if !yield(&model.LLMResponse{
					Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: delta, Thought: true}}},
					Partial: true,
				}, nil) {
					return
				}
			}
			for _, delta := range deltasOf(turn) {
				if delta == "" {
					continue
				}
				if !yield(&model.LLMResponse{
					Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: delta}}},
					Partial: true,
				}, nil) {
					return
				}
			}
		}
		yield(&model.LLMResponse{
			Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
			UsageMetadata: Usage,
			TurnComplete:  true,
			FinishReason:  genai.FinishReasonStop,
		}, nil)
	}
}

func deltasOf(turn Script) []string {
	if len(turn.Deltas) > 0 {
		return turn.Deltas
	}
	if turn.Text == "" {
		return nil
	}
	return strings.Split(turn.Text, " ")
}

func lastUserText(req *model.LLMRequest) string {
	if req == nil {
		return ""
	}
	for i := len(req.Contents) - 1; i >= 0; i-- {
		c := req.Contents[i]
		if c == nil || c.Role != genai.RoleUser {
			continue
		}
		var sb strings.Builder
		for _, p := range c.Parts {
			if p != nil && p.Text != "" && !p.Thought {
				sb.WriteString(p.Text)
			}
		}
		return sb.String()
	}
	return ""
}

// splitDeltas 把文本拆成词级的流式分块。
func splitDeltas(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(text, " ")
}

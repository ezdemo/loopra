package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"strings"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/model/config"
)

func TestCompactCommand(t *testing.T) {
	for _, scenario := range []string{"success", "tool_boundary", "empty", "disabled", "failure", "cancelled", "cancel_summary"} {
		t.Run(scenario, func(t *testing.T) {
			success := scenario == "success" || scenario == "tool_boundary"
			cfg := config.Default()
			cfg.ContextCompaction.RetainEvents = 2
			if scenario == "tool_boundary" {
				cfg.ContextCompaction.ToolResultPrune.ThresholdChars = -1
			}
			if scenario == "disabled" {
				enabled := false
				cfg.ContextCompaction.Enabled = &enabled
			}
			m := &longLoopModel{calls: 7, failSummary: scenario == "failure"}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var llm model.LLM = m
			if scenario == "cancel_summary" {
				llm = &cancelSummaryModel{LLM: m, cancel: cancel}
			}
			root := t.TempDir()
			a, err := New(root, "project", &cfg, Options{Model: llm})
			if err != nil {
				t.Fatal(err)
			}
			sess := createSession(t, a, "manual").Session
			historyCount := 0
			if scenario != "empty" {
				historyCount = 8
				for i := range historyCount {
					role, author := genai.Role(genai.RoleUser), "user"
					if i%2 == 1 {
						role, author = genai.RoleModel, a.Root.Name()
					}
					event := &session.Event{
						ID: fmt.Sprintf("history-%d", i), Author: author,
						InvocationID: fmt.Sprintf("turn-%d", i/2),
						Timestamp:    time.Now().Add(time.Duration(i-historyCount) * time.Second),
					}
					event.Content = genai.NewContentFromText(fmt.Sprintf("history-%d: %s", i, strings.Repeat("exact evidence ", 50)), role)
					if role == genai.RoleModel {
						event.FinishReason = genai.FinishReasonStop
					}
					if scenario == "tool_boundary" {
						if i == 5 {
							event.Content.Parts = append(event.Content.Parts, &genai.Part{FunctionCall: &genai.FunctionCall{
								ID: "retained-call", Name: "probe", Args: map[string]any{},
							}})
						}
						if i == 6 {
							event.Content.Parts = []*genai.Part{{FunctionResponse: &genai.FunctionResponse{
								ID: "retained-call", Name: "probe", Response: map[string]any{"result": "history-6: exact tool evidence"},
							}}}
						}
					}
					if err := a.Sessions.AppendEvent(t.Context(), sess, event); err != nil {
						t.Fatal(err)
					}
				}
			}
			if scenario == "cancelled" {
				cancel()
			}
			var runErr error
			reply := ""
			for event, err := range a.Run(ctx, sess, genai.NewContentFromText(" \n/compact \t", genai.RoleUser)) {
				if err != nil {
					runErr = err
					break
				}
				if event.Content != nil && event.Content.Role == genai.RoleModel {
					reply += plainText(event.Content)
				}
			}
			if m.calls != 7 {
				t.Fatal("/compact reached the conversational model")
			}
			wantSummary := success || scenario == "failure" || scenario == "cancel_summary"
			if wantSummary && m.summaries != 1 || !wantSummary && m.summaries != 0 {
				t.Fatalf("summary calls=%d scenario=%s", m.summaries, scenario)
			}
			switch scenario {
			case "success", "tool_boundary":
				if runErr != nil || !strings.Contains(reply, "上下文已压缩") {
					t.Fatalf("reply=%q err=%v", reply, runErr)
				}
			case "empty":
				if runErr != nil || !strings.Contains(reply, "没有可压缩") {
					t.Fatalf("reply=%q err=%v", reply, runErr)
				}
			case "cancelled", "cancel_summary":
				// ADK 可以直接结束已取消的迭代；不得发起摘要或写入检查点。
				if runErr != nil && !errors.Is(runErr, context.Canceled) {
					t.Fatal(runErr)
				}
			default:
				if runErr == nil || reply != "" {
					t.Fatalf("failed command reported success: reply=%q err=%v", reply, runErr)
				}
			}
			restored, err := jsonl.NewService(root).Get(t.Context(), &session.GetRequest{
				AppName: a.App(), UserID: a.User(), SessionID: sess.ID(),
			})
			if err != nil {
				t.Fatal(err)
			}
			checkpoints := 0
			originals := 0
			for event := range restored.Session.Events().All() {
				if event.Actions.Compaction != nil {
					checkpoints++
				}
				if strings.HasPrefix(event.ID, "history-") {
					originals++
				}
			}
			wantCheckpoints := 0
			if success {
				wantCheckpoints = 1
			}
			if checkpoints != wantCheckpoints || originals != historyCount {
				t.Fatalf("checkpoints=%d originals=%d", checkpoints, originals)
			}
			if !success {
				return
			}
			// 冷启动后下一次普通请求必须消费检查点，同时保留最近两条原文。
			a, err = New(root, "project", &cfg, Options{Model: m})
			if err != nil {
				t.Fatal(err)
			}
			for _, err := range a.Run(t.Context(), restored.Session, genai.NewContentFromText("continue", genai.RoleUser)) {
				if err != nil {
					t.Fatal(err)
				}
			}
			if m.calls != 8 || len(m.requests) != 1 {
				t.Fatalf("normal model calls=%d requests=%d", m.calls, len(m.requests))
			}
			rawContents, err := json.Marshal(m.requests[0].Contents)
			if err != nil {
				t.Fatal(err)
			}
			contents := string(rawContents)
			if !strings.Contains(contents, "Checkpoint:") || strings.Contains(contents, "history-0:") ||
				!strings.Contains(contents, "history-6:") || !strings.Contains(contents, "history-7:") {
				t.Fatalf("next request did not use checkpoint with retained tail: %s", contents)
			}
			if scenario == "tool_boundary" {
				calls, results := 0, 0
				for _, content := range m.requests[0].Contents {
					for _, part := range content.Parts {
						if part.FunctionCall != nil && part.FunctionCall.ID == "retained-call" {
							calls++
						}
						if part.FunctionResponse != nil && part.FunctionResponse.ID == "retained-call" {
							results++
						}
					}
				}
				if calls != 1 || results != 1 {
					t.Fatalf("compaction split a retained tool exchange: calls=%d results=%d", calls, results)
				}
			}
		})
	}
}

type cancelSummaryModel struct {
	model.LLM
	cancel context.CancelFunc
}

func (m *cancelSummaryModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	if !stream {
		m.cancel()
	}
	return m.LLM.GenerateContent(ctx, req, stream)
}

func TestCompactCommandMatchesOnlyStandaloneText(t *testing.T) {
	for _, text := range []string{"/compact", " /compact\n"} {
		if !isCompactCommand(genai.NewContentFromText(text, genai.RoleUser)) {
			t.Fatalf("command not recognized: %q", text)
		}
	}
	for _, text := range []string{"/compactness", "/compact explain", "请解释 /compact", "```\n/compact\n```"} {
		if isCompactCommand(genai.NewContentFromText(text, genai.RoleUser)) {
			t.Fatalf("ordinary text recognized as command: %q", text)
		}
	}
	if isCompactCommand(genai.NewContentFromText("/compact", genai.RoleModel)) ||
		isCompactCommand(&genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: "/compact"}, {InlineData: &genai.Blob{MIMEType: "image/png", Data: []byte{1}}}}}) {
		t.Fatal("non-command content recognized as command")
	}
}

package echo

import (
	"context"
	"testing"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
)

// TestFullAgentLoopThroughAdkRunner 用脚本化模型驱动完整的 ADK 链路：
// runner -> llmagent -> functiontool -> session events。它是
// M0 门禁，用于证明提供商约定在真实框架中依然成立。
func TestFullAgentLoopThroughAdkRunner(t *testing.T) {
	echoTool, err := functiontool.New[struct {
		Text string `json:"text" jsonschema:"text to echo"`
	}, map[string]any](functiontool.Config{Name: "echo", Description: "echo the text"},
		func(ctx agent.Context, in struct {
			Text string `json:"text" jsonschema:"text to echo"`
		}) (map[string]any, error) {
			return map[string]any{"result": "echoed: " + in.Text}, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	m := New("scripted",
		Script{Thought: "thinking...", Text: "calling tool", ToolCalls: []*genai.FunctionCall{
			{Name: "echo", Args: map[string]any{"text": "hi"}},
		}},
		Script{Text: "all done"},
	)

	root, err := llmagent.New(llmagent.Config{
		Name:        "smoke",
		Model:       m,
		Description: "smoke agent",
		Instruction: "You echo things.",
		Tools:       []tool.Tool{echoTool},
	})
	if err != nil {
		t.Fatal(err)
	}

	svc := session.InMemoryService()
	sess, err := svc.Create(context.Background(), &session.CreateRequest{AppName: "app", UserID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := runner.New(runner.Config{AppName: "app", Agent: root, SessionService: svc})
	if err != nil {
		t.Fatal(err)
	}

	var partials, finalText, sawFinal int
	var sawToolEvent bool
	var gotFinal string
	for ev, err := range r.Run(context.Background(), "u1", sess.Session.ID(),
		genai.NewContentFromText("please echo", genai.RoleUser),
		agent.RunConfig{StreamingMode: agent.StreamingModeSSE}) {
		if err != nil {
			t.Fatalf("run error: %v", err)
		}
		if ev.Partial {
			partials++
		}
		if ev.Content != nil {
			for _, p := range ev.Content.Parts {
				if p.FunctionCall != nil {
					sawToolEvent = true
				}
			}
		}
		if ev.IsFinalResponse() {
			sawFinal++
			for _, p := range ev.Content.Parts {
				if p.Text != "" {
					gotFinal = p.Text
					finalText++
				}
			}
		}
	}
	if !sawToolEvent {
		t.Fatal("expected a function call event in the stream")
	}
	if sawFinal != 1 {
		t.Fatalf("final responses = %d, want 1", sawFinal)
	}
	if gotFinal != "all done" {
		t.Fatalf("final text = %q", gotFinal)
	}
	if finalText != 1 {
		t.Fatalf("final text parts = %d", finalText)
	}
	if partials == 0 {
		t.Fatal("expected streaming partial events")
	}
	// 会话历史必须包含该工具调用及其响应。
	stored, err := svc.Get(context.Background(), &session.GetRequest{AppName: "app", UserID: "u1", SessionID: sess.Session.ID()})
	if err != nil {
		t.Fatal(err)
	}
	var calls, responses int
	for i := range stored.Session.Events().Len() {
		ev := stored.Session.Events().At(i)
		if ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionCall != nil {
				calls++
			}
			if p.FunctionResponse != nil {
				responses++
			}
		}
	}
	if calls == 0 || responses == 0 {
		t.Fatalf("session history missing tool exchange: calls=%d responses=%d", calls, responses)
	}
	t.Logf("partials=%d final=%q calls=%d responses=%d", partials, gotFinal, calls, responses)
}

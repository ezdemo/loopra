package agent

import (
	"context"
	"testing"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
)

// 提示词里的花括号示例（如工作区 AGENTS.md 中的 @Mapping("/getInfo/{id}")）
// 必须原样保留，不能被 ADK 当成会话状态占位符而报 state key does not exist。
func TestInstructionKeepsLiteralBraces(t *testing.T) {
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{
		Model:       echo.New("fixture", echo.Script{Text: "done"}),
		Instruction: "示例：@Mapping(\"/getInfo/{id}\")，模板变量写作 ${id}。",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := a.Sessions.Create(ctx, &session.CreateRequest{AppName: a.App(), UserID: a.User(), SessionID: "braces"})
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range a.Run(ctx, created.Session, &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: "hi"}}}) {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestDerivedRunnerSharesSessionState(t *testing.T) {
	probe, _ := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "state_probe"}, func(ctx adkagent.Context, _ struct{}) (map[string]any, error) {
		value, err := ctx.State().Get("fixture")
		if err != nil {
			return nil, err
		}
		if err := ctx.State().Set("result", value); err != nil {
			return nil, err
		}
		return map[string]any{"result": value}, nil
	})
	cfg := config.Default()
	a, err := New(t.TempDir(), "project", &cfg, Options{Tools: []tool.Tool{probe}, Model: echo.New("fixture", echo.Script{ToolCalls: []*genai.FunctionCall{{Name: "state_probe"}}}, echo.Script{Text: "done"})})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := a.Sessions.Create(ctx, &session.CreateRequest{AppName: a.App(), UserID: a.User(), SessionID: "shared", State: map[string]any{"fixture": "root-state"}})
	if err != nil {
		t.Fatal(err)
	}
	derived, err := a.Derive(a.App(), &cfg, nil, "Derived instruction")
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range derived.Run(ctx, created.Session, &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: "run state probe"}}}) {
		if err != nil {
			t.Fatal(err)
		}
	}
	stored, err := a.Sessions.Get(ctx, &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	value, err := stored.Session.State().Get("result")
	if err != nil || value != "root-state" {
		t.Fatalf("derived runner used a separate session service: result=%v err=%v", value, err)
	}
}

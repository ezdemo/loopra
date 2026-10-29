package controller

import (
	"context"
	"testing"

	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"
)

// TestHITLResumeAcrossRuns 验证确认恢复协议
// 能在 JSONL 会话往返中保持一致：第一轮在受门控的
// 调用上暂停，第二轮答复确认并重新派发该调用。
func TestHITLResumeAcrossRuns(t *testing.T) {
	danger := testDangerTool(t)
	reg := testRegistry(t, danger)
	a, _ := testHitlAgent(t, reg)
	// 策略通过服务器构造函数安装；构造一个服务器实例，以便按
	// 线上服务器的方式对注册表进行门控。
	srv, _, err := New(a, Options{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })

	ctx := context.Background()
	sess, err := a.Session(ctx, "dbg")
	if err != nil {
		t.Fatal(err)
	}
	var confirmID string
	for ev, err := range a.Run(ctx, sess, &genai.Content{Role: "user", Parts: []*genai.Part{{Text: "go"}}}) {
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName {
				confirmID = p.FunctionCall.ID
			}
		}
	}
	if confirmID == "" {
		t.Fatal("no confirmation call seen")
	}
	// 重新加载的会话必须能暴露已持久化的确认事件。
	got, err := a.Sessions.Get(ctx, &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: "dbg"})
	if err != nil {
		t.Fatal(err)
	}
	evs := got.Session.Events()
	found := false
	for i := 0; i < evs.Len(); i++ {
		for _, p := range evs.At(i).Content.Parts {
			if p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("confirmation event lost across the JSONL round trip")
	}

	// 第二个处理轮次答复确认后会重新派发该调用。
	resumed := 0
	for ev, err := range a.Run(ctx, sess, &genai.Content{Role: "user", Parts: []*genai.Part{{
		FunctionResponse: &genai.FunctionResponse{
			Name: toolconfirmation.FunctionCallName, ID: confirmID,
			Response: map[string]any{"confirmed": true},
		},
	}}}) {
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionResponse != nil && p.FunctionResponse.Name == "danger" {
				resumed++
			}
		}
	}
	if resumed == 0 {
		t.Fatal("resume re-dispatched nothing")
	}
}

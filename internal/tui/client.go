package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	acpsdk "github.com/coder/acp-go-sdk"
)

type chunkMsg string

type noteMsg string

// questionMsg 把运行时的审批或选择请求带进渲染循环。
// count 为零表示审批（回答 y 允许一次），非零表示编号选择。
type questionMsg struct {
	ctx   context.Context
	text  string
	count int
	reply chan string
}

// terminalClient 把 ACP 运行时的出站交互转发给 Bubble Tea 程序。
type terminalClient struct {
	send func(tea.Msg)
}

// terminalText 去掉会破坏终端渲染的控制字符。
func terminalText(text string) string {
	return strings.Map(func(r rune) rune {
		if r == '\t' {
			return ' '
		}
		if r == '\n' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, text)
}

func oneLine(text string) string {
	return strings.ReplaceAll(terminalText(text), "\n", " ")
}

// ask 把问题交给渲染循环，等待用户回答或 ctx 结束。
func (c *terminalClient) ask(ctx context.Context, text string, count int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	reply := make(chan string, 1)
	c.send(questionMsg{ctx: ctx, text: text, count: count, reply: reply})
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case answer := <-reply:
		return answer, ctx.Err()
	}
}

func (c *terminalClient) SessionUpdate(_ context.Context, note acpsdk.SessionNotification) error {
	update := note.Update
	switch {
	case update.AgentMessageChunk != nil:
		if text := update.AgentMessageChunk.Content.Text; text != nil && text.Text != "" {
			c.send(chunkMsg(terminalText(text.Text)))
		}
	case update.ToolCall != nil:
		call := update.ToolCall
		if call.Status != acpsdk.ToolCallStatusPending {
			title := call.Title
			if title == "" {
				title = string(call.ToolCallId)
			}
			c.send(noteMsg("Tool: " + oneLine(title)))
		}
	case update.ToolCallUpdate != nil:
		upd := update.ToolCallUpdate
		if upd.Status != nil && *upd.Status == acpsdk.ToolCallStatusFailed {
			title := string(upd.ToolCallId)
			if upd.Title != nil && *upd.Title != "" {
				title = *upd.Title
			}
			c.send(noteMsg("Tool failed: " + oneLine(title)))
		}
	}
	return nil
}

func (c *terminalClient) RequestPermission(ctx context.Context, req acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	selected := func(option acpsdk.PermissionOptionId) acpsdk.RequestPermissionResponse {
		return acpsdk.RequestPermissionResponse{Outcome: acpsdk.RequestPermissionOutcome{
			Selected: &acpsdk.RequestPermissionOutcomeSelected{Outcome: "selected", OptionId: option},
		}}
	}
	title := string(req.ToolCall.ToolCallId)
	if req.ToolCall.Title != nil && *req.ToolCall.Title != "" {
		title = *req.ToolCall.Title
	}
	text := "Allow tool: " + oneLine(title)
	if req.ToolCall.RawInput != nil {
		args, err := json.MarshalIndent(req.ToolCall.RawInput, "", "  ")
		if err != nil {
			return selected("reject_once"), nil
		}
		text += "\n" + terminalText(string(args))
	}
	answer, err := c.ask(ctx, text, 0)
	if err != nil {
		return acpsdk.RequestPermissionResponse{}, err
	}
	option := acpsdk.PermissionOptionId("reject_once")
	if strings.EqualFold(answer, "y") {
		option = "allow_once"
	}
	return selected(option), nil
}

func (c *terminalClient) UnstableCreateElicitation(ctx context.Context, req acpsdk.UnstableCreateElicitationRequest) (acpsdk.UnstableCreateElicitationResponse, error) {
	if req.Form == nil {
		return acpsdk.NewUnstableCreateElicitationResponseDecline(), nil
	}
	property, ok := req.Form.RequestedSchema.Properties["choice"].(map[string]any)
	if !ok {
		return acpsdk.NewUnstableCreateElicitationResponseDecline(), nil
	}
	options, ok := property["enum"].([]string)
	if !ok || len(options) == 0 {
		return acpsdk.NewUnstableCreateElicitationResponseDecline(), nil
	}
	var text strings.Builder
	text.WriteString(terminalText(req.Form.Message))
	for i, option := range options {
		fmt.Fprintf(&text, "\n%d. %s", i+1, oneLine(option))
	}
	answer, err := c.ask(ctx, text.String(), len(options))
	if err != nil {
		return acpsdk.UnstableCreateElicitationResponse{}, err
	}
	n, _ := strconv.Atoi(answer)
	if n < 1 || n > len(options) {
		return acpsdk.NewUnstableCreateElicitationResponseCancel(), nil
	}
	response := acpsdk.NewUnstableCreateElicitationResponseAccept()
	response.Accept.Content = map[string]any{"choice": options[n-1]}
	return response, nil
}

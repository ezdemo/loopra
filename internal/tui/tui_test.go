package tui

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/acpserver"
	modelconfig "github.com/ezdemo/looprax/internal/model/config"
)

func TestTUIRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cfg := modelconfig.Default()
	cfg.Hitl = "free"
	runtime := acpserver.New(t.TempDir(), &cfg)
	runtime.UseModel(echo.New("echo", echo.Script{Text: "pong"}))
	created, err := runtime.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	msgs := make(chan tea.Msg, 64)
	send := func(msg tea.Msg) { msgs <- msg }
	m := newModel(ctx, runtime.Prompt, t.TempDir(), created.SessionId, newTheme(io.Discard))
	m.send = send
	runtime.SetClient(&terminalClient{send: send})
	defer runtime.SetClient(nil)

	_ = m.Init()
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.input.SetValue("ping")
	m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("second line")})
	if got := m.input.Value(); got != "ping\nsecond line" {
		t.Fatalf("composer value = %q", got)
	}
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.cancel == nil {
		t.Fatal("turn did not start")
	}
	deadline := time.After(15 * time.Second)
	for m.cancel != nil {
		select {
		case msg := <-msgs:
			m.Update(msg)
		case <-deadline:
			t.Fatal("turn did not finish")
		}
	}
	m.workers.Wait()
	view := m.View()
	for _, want := range []string{"ping", "second line", "pong"} {
		if !strings.Contains(view, want) {
			t.Fatalf("view missing %q:\n%s", want, view)
		}
	}
	if strings.Contains(view, "You:") || strings.Contains(view, "Loopra:") {
		t.Fatalf("view kept role prefixes:\n%s", view)
	}
	if strings.Count(view, "pong") != 1 {
		t.Fatalf("duplicated agent text:\n%s", view)
	}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("idle Ctrl+C produced no command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("idle Ctrl+C did not produce tea.QuitMsg")
	}
}

func TestTUIForwardsCursorMessages(t *testing.T) {
	m := newModel(context.Background(), nil, t.TempDir(), "session", newTheme(io.Discard))
	init := m.Init()
	if init == nil {
		t.Fatal("expected a cursor initialization command")
	}
	_, next := m.Update(init())
	if next == nil {
		t.Fatal("cursor initialization message was not forwarded")
	}
}

// askPermission 在模拟的活动轮次里发起一次审批请求，返回等待中的问题与结果通道。
func askPermission(t *testing.T, m *model, client *terminalClient, ctx context.Context, msgs chan tea.Msg, title string) chan acpsdk.RequestPermissionResponse {
	t.Helper()
	done := make(chan acpsdk.RequestPermissionResponse, 1)
	go func() {
		resp, err := client.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
			ToolCall: acpsdk.ToolCallUpdate{
				ToolCallId: "call-1",
				Title:      acpsdk.Ptr(title),
				RawInput:   map[string]any{"path": "demo.txt"},
			},
		})
		if err != nil {
			done <- acpsdk.RequestPermissionResponse{}
			return
		}
		done <- resp
	}()
	deadline := time.After(5 * time.Second)
	for len(m.pending) == 0 {
		select {
		case msg := <-msgs:
			m.Update(msg)
		case <-deadline:
			t.Fatal("permission question did not arrive")
		}
	}
	return done
}

func permissionChoice(t *testing.T, done chan acpsdk.RequestPermissionResponse) acpsdk.PermissionOptionId {
	t.Helper()
	select {
	case resp := <-done:
		if resp.Outcome.Selected == nil {
			t.Fatal("permission outcome was not selected")
		}
		return resp.Outcome.Selected.OptionId
	case <-time.After(5 * time.Second):
		t.Fatal("permission request did not resolve")
		return ""
	}
}

func TestTerminalClientQuestions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	msgs := make(chan tea.Msg, 64)
	send := func(msg tea.Msg) { msgs <- msg }
	client := &terminalClient{send: send}
	m := newModel(ctx, nil, t.TempDir(), "session", newTheme(io.Discard))
	m.send = send
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})

	newTurn := func() context.Context {
		turnCtx, turnCancel := context.WithCancel(ctx)
		m.cancel = turnCancel
		m.stopping = false
		return turnCtx
	}

	// 默认回车拒绝；只有明确输入 y 才允许一次。
	turnCtx := newTurn()
	done := askPermission(t, m, client, turnCtx, msgs, "danger \x1b[31m tool")
	if !strings.Contains(m.View(), "Allow tool") {
		t.Fatalf("view missing approval:\n%s", m.View())
	}
	if strings.Contains(m.View(), "\x1b") {
		t.Fatalf("control sequence reached the view:\n%s", m.View())
	}
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := permissionChoice(t, done); got != "reject_once" {
		t.Fatalf("default answer = %q", got)
	}

	turnCtx = newTurn()
	done = askPermission(t, m, client, turnCtx, msgs, "write file")
	m.input.SetValue("y")
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := permissionChoice(t, done); got != "allow_once" {
		t.Fatalf("y answer = %q", got)
	}

	// 编号选择：非法输入不提交，回车选 2，空输入取消。
	type choiceResult struct {
		resp acpsdk.UnstableCreateElicitationResponse
		err  error
	}
	askChoice := func() chan choiceResult {
		props := map[string]any{"choice": map[string]any{"type": "string", "enum": []string{"alpha", "beta", "gamma"}}}
		req := acpsdk.NewUnstableCreateElicitationRequestForm(acpsdk.UnstableElicitationSchema{
			Type: "object", Properties: props, Required: []string{"choice"},
		})
		req.Form.Message = "pick one"
		turnCtx := newTurn()
		out := make(chan choiceResult, 1)
		go func() {
			resp, err := client.UnstableCreateElicitation(turnCtx, req)
			out <- choiceResult{resp, err}
		}()
		deadline := time.After(5 * time.Second)
		for len(m.pending) == 0 {
			select {
			case msg := <-msgs:
				m.Update(msg)
			case <-deadline:
				t.Fatal("choice question did not arrive")
			}
		}
		return out
	}
	choiceDone := askChoice()
	m.input.SetValue("9")
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if len(m.pending) != 1 {
		t.Fatal("out-of-range choice was submitted")
	}
	m.input.SetValue("2")
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	select {
	case got := <-choiceDone:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.resp.Accept == nil || got.resp.Accept.Content["choice"] != "beta" {
			t.Fatalf("choice result = %+v", got.resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("choice request did not resolve")
	}

	choiceDone = askChoice()
	m.input.Reset()
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	select {
	case got := <-choiceDone:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.resp.Cancel == nil {
			t.Fatalf("empty answer did not cancel: %+v", got.resp)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("empty choice did not resolve")
	}

	// Ctrl+C 取消轮次并释放挂起的问题，不产生批准。
	turnCtx = newTurn()
	waitErr := make(chan error, 1)
	go func() {
		_, err := client.RequestPermission(turnCtx, acpsdk.RequestPermissionRequest{
			ToolCall: acpsdk.ToolCallUpdate{ToolCallId: "call-2", Title: acpsdk.Ptr("pending")},
		})
		waitErr <- err
	}()
	deadline := time.After(5 * time.Second)
	for len(m.pending) == 0 {
		select {
		case msg := <-msgs:
			m.Update(msg)
		case <-deadline:
			t.Fatal("permission question did not arrive")
		}
	}
	m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	select {
	case err := <-waitErr:
		if err == nil {
			t.Fatal("cancelled permission request returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Ctrl+C did not release the pending question")
	}
	if len(m.pending) != 0 {
		t.Fatal("pending questions left after cancel")
	}
}

// TestTUIViewFitsTerminal 检查几种窗口尺寸下每行都不超宽、
// 行数正好铺满终端，并覆盖宽字符路径、模型名与转录。
func TestTUIViewFitsTerminal(t *testing.T) {
	check := func(m *model, w, h int) string {
		t.Helper()
		view := m.View()
		lines := strings.Split(view, "\n")
		if len(lines) != h {
			t.Fatalf("%dx%d rows = %d, want %d:\n%s", w, h, len(lines), h, view)
		}
		for i, line := range lines {
			if got := ansi.StringWidth(line); got > w {
				t.Fatalf("%dx%d line %d width %d > %d: %q", w, h, i, got, w, line)
			}
		}
		return view
	}
	for _, size := range []struct{ w, h int }{{24, 9}, {80, 24}, {132, 30}} {
		m := newModel(context.Background(), nil, t.TempDir(), "session", newTheme(io.Discard))
		m.Update(tea.WindowSizeMsg{Width: size.w, Height: size.h})
		view := check(m, size.w, size.h)
		if !strings.Contains(view, "Enter send") {
			t.Fatalf("%dx%d idle missing key hint:\n%s", size.w, size.h, view)
		}
		if !strings.Contains(view, "L O O P R A") {
			t.Fatalf("%dx%d idle missing brand mark:\n%s", size.w, size.h, view)
		}
		var top, mid, bottom = -1, -1, -1
		for _, line := range strings.Split(view, "\n") {
			if i := strings.Index(line, "╭─────╮"); i >= 0 {
				top = i
			}
			if i := strings.Index(line, "│ └─  │"); i >= 0 {
				mid = i
			}
			if i := strings.Index(line, "╰─────╯"); i >= 0 {
				bottom = i
			}
		}
		if top < 0 || top != mid || top != bottom {
			t.Fatalf("%dx%d logo rows misaligned %d/%d/%d:\n%s", size.w, size.h, top, mid, bottom, view)
		}
		m.cwd = "工作目录/深度学习项目/很长的尾巴"
		m.modelName = "深度求索-v4-超长模型名"
		m.note(entryUser, "读一下配置文件")
		m.Update(chunkMsg("已读取，正在分析。"))
		view = check(m, size.w, size.h)
		if !strings.Contains(view, "尾巴") {
			t.Fatalf("%dx%d header lost the path tail:\n%s", size.w, size.h, view)
		}
		if !strings.Contains(view, "已读取，正在分析。") {
			t.Fatalf("%dx%d missing assistant text:\n%s", size.w, size.h, view)
		}
	}
}

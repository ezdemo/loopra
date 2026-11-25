// Package tui 在终端里提供 Loopra 单会话聊天界面。
// 它在进程内复用 ACP 运行时：不监听 HTTP，也不另起 ACP 进程。
package tui

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/acpserver"
)

// 低于这个尺寸时停止接受输入，只提示放大窗口，避免在看不见内容时误批准。
const (
	minWidth  = 24
	minHeight = 9
)

type finishedMsg struct {
	reason acpsdk.StopReason
	err    error
}

// model 是界面状态的唯一所有者；模型与工具调用在 worker goroutine 里运行，
// 通过 tea.Msg 回到渲染循环。
type model struct {
	ctx       context.Context
	prompt    func(context.Context, acpsdk.PromptRequest) (acpsdk.PromptResponse, error)
	send      func(tea.Msg)
	id        acpsdk.SessionId
	cwd       string
	modelName string
	styles    theme
	input     textarea.Model
	spinner   spinner.Model
	viewport  viewport.Model
	width     int
	height    int
	entries   []entry
	replying  bool
	pending   []questionMsg
	workers   sync.WaitGroup
	cancel    context.CancelFunc
	stopping  bool
}

// Run 开一个工作目录为 cwd 的新会话，并在当前终端里渲染到程序退出。
func Run(ctx context.Context, runtime *acpserver.Runtime, cwd string, input io.Reader, output io.Writer) error {
	created, err := runtime.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: cwd})
	if err != nil {
		return err
	}
	m := newModel(ctx, runtime.Prompt, cwd, created.SessionId, newTheme(output))
	m.modelName = currentModelName(created.ConfigOptions)
	p := tea.NewProgram(m,
		tea.WithContext(ctx),
		tea.WithoutSignalHandler(),
		tea.WithAltScreen(),
		tea.WithInput(input),
		tea.WithOutput(output),
	)
	m.send = p.Send
	runtime.SetClient(&terminalClient{send: p.Send})
	defer runtime.SetClient(nil)
	_, err = p.Run()
	if m.cancel != nil {
		m.cancel()
	}
	m.workers.Wait()
	if ctx.Err() != nil && errors.Is(err, tea.ErrProgramKilled) {
		return nil
	}
	return err
}

// currentModelName 从会话配置里取当前模型名，放在按键栏左侧。
func currentModelName(options []acpsdk.SessionConfigOption) string {
	for _, option := range options {
		if option.Select == nil || option.Select.Id != "model" {
			continue
		}
		current := string(option.Select.CurrentValue)
		if _, name, ok := strings.Cut(current, ":"); ok {
			current = name
		}
		return oneLine(current)
	}
	return ""
}

func newModel(ctx context.Context, prompt func(context.Context, acpsdk.PromptRequest) (acpsdk.PromptResponse, error), cwd string, id acpsdk.SessionId, styles theme) *model {
	input := textarea.New()
	input.Prompt = ""
	input.Placeholder = "Ask Loopra..."
	input.ShowLineNumbers = false
	input.MaxWidth = 0
	input.CharLimit = 0
	input.KeyMap.InsertNewline = key.NewBinding(key.WithKeys("ctrl+j"))
	input.FocusedStyle = textarea.Style{Placeholder: styles.muted}
	input.BlurredStyle = input.FocusedStyle
	return &model{
		ctx:      ctx,
		prompt:   prompt,
		id:       id,
		cwd:      oneLine(cwd),
		styles:   styles,
		input:    input,
		spinner:  spinner.New(spinner.WithSpinner(spinner.Dot), spinner.WithStyle(styles.accent)),
		viewport: viewport.New(0, 0),
	}
}

func (m *model) Init() tea.Cmd {
	return m.input.Focus()
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		following := m.viewport.AtBottom()
		m.width, m.height = msg.Width, msg.Height
		cols := columnWidth(m.width)
		if m.viewport.Width != cols {
			for i := range m.entries {
				m.entries[i].rendered = ""
			}
		}
		m.viewport.Width = cols
		m.input.SetWidth(max(1, cols-4))
		m.input.SetHeight(composerHeight(m.height))
		m.viewport.Height = max(1, m.height-5-m.input.Height())
		m.refresh(following)
		return m, nil
	case chunkMsg:
		text := string(msg)
		if m.replying && len(m.entries) > 0 {
			last := &m.entries[len(m.entries)-1]
			last.text += text
			last.rendered = ""
		} else {
			m.entries = append(m.entries, entry{kind: entryAgent, text: text})
			m.replying = true
		}
		m.refresh(m.viewport.AtBottom())
		return m, nil
	case noteMsg:
		m.note(entryTool, string(msg))
		return m, nil
	case questionMsg:
		if m.cancel == nil || m.stopping || msg.ctx.Err() != nil {
			select {
			case msg.reply <- "":
			default:
			}
			return m, nil
		}
		m.pending = append(m.pending, msg)
		if len(m.pending) == 1 {
			m.showQuestion()
		}
		return m, nil
	case finishedMsg:
		if m.cancel != nil {
			m.cancel()
			m.cancel = nil
		}
		m.stopping = false
		m.replying = false
		m.drainPending()
		m.input.Reset()
		m.input.Placeholder = "Ask Loopra..."
		switch {
		case msg.reason == acpsdk.StopReasonCancelled:
			m.note(entryNotice, "Cancelled.")
		case msg.err != nil:
			m.note(entryError, "Error: "+terminalText(msg.err.Error()))
		}
		return m, nil
	case spinner.TickMsg:
		if !m.busy() {
			return m, nil
		}
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case tea.KeyMsg:
		return m, m.key(msg)
	}
	return m, m.updateInput(msg)
}

// updateInput 把非按键消息（光标定时、异步粘贴等）也交给输入框。
func (m *model) updateInput(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return cmd
}

func (m *model) busy() bool {
	return m.cancel != nil || m.stopping
}

func (m *model) normalSize() bool {
	return m.width >= minWidth && m.height >= minHeight
}

// note 追加一条转录；只有视口原来就在底部时才继续跟随。
func (m *model) note(kind entryKind, text string) {
	m.replying = false
	m.entries = append(m.entries, entry{kind: kind, text: text})
	m.refresh(m.viewport.AtBottom())
}

func (m *model) refresh(follow bool) {
	if m.viewport.Width <= 0 {
		return
	}
	var b strings.Builder
	for i := range m.entries {
		e := &m.entries[i]
		if e.rendered == "" {
			e.rendered = m.styles.renderEntry(*e, m.viewport.Width)
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(e.rendered)
	}
	m.viewport.SetContent(b.String())
	if follow {
		m.viewport.GotoBottom()
	}
}

// showQuestion 把队首问题写入转录。问题比视口高时先停在问题开头，
// 不让首行内容被滚出屏幕外。
func (m *model) showQuestion() {
	if len(m.pending) == 0 {
		return
	}
	m.input.Reset()
	question := m.pending[0]
	if question.count > 0 {
		m.input.Placeholder = "Choose a number"
	} else {
		m.input.Placeholder = "Allow once? [y/N]"
	}
	m.note(entryQuestion, question.text)
	if m.viewport.Width <= 0 {
		return
	}
	m.viewport.GotoBottom()
	lines := strings.Count(m.entries[len(m.entries)-1].rendered, "\n") + 1
	if lines > m.viewport.Height {
		m.viewport.SetYOffset(m.viewport.TotalLineCount() - lines)
	}
}

func (m *model) drainPending() {
	for _, question := range m.pending {
		select {
		case question.reply <- "":
		default:
		}
	}
	m.pending = nil
}

// answer 回答队首问题。编号选择接受空输入（取消）和 1..count；
// 非法输入留在输入框里不提交。
func (m *model) answer(text string) {
	if len(m.pending) == 0 {
		return
	}
	question := m.pending[0]
	if question.count > 0 && text != "" {
		n, err := strconv.Atoi(text)
		if err != nil || n < 1 || n > question.count {
			return
		}
	}
	question.reply <- text
	m.pending = m.pending[1:]
	m.input.Reset()
	if len(m.pending) > 0 {
		m.showQuestion()
	}
}

// start 记录用户输入并在 worker 里跑完本轮，结果经 finishedMsg 回来。
func (m *model) start(message string) {
	m.note(entryUser, terminalText(message))
	m.viewport.GotoBottom()
	ctx, cancel := context.WithCancel(m.ctx)
	m.cancel = cancel
	m.spinner = spinner.New(spinner.WithSpinner(spinner.Dot), spinner.WithStyle(m.styles.accent))
	m.workers.Go(func() {
		result, err := m.prompt(ctx, acpsdk.PromptRequest{
			SessionId: m.id,
			Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock(message)},
		})
		reason := result.StopReason
		if ctx.Err() != nil {
			reason = acpsdk.StopReasonCancelled
		}
		m.send(finishedMsg{reason: reason, err: err})
	})
}

func (m *model) key(msg tea.KeyMsg) tea.Cmd {
	switch msg.Type {
	case tea.KeyCtrlC:
		if m.cancel != nil {
			m.cancel()
			m.cancel = nil
			m.stopping = true
			m.drainPending()
			m.input.Reset()
			return nil
		}
		return tea.Quit
	case tea.KeyEsc:
		if len(m.pending) > 0 {
			m.answer("")
		}
		return nil
	case tea.KeyPgUp, tea.KeyPgDown:
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return cmd
	case tea.KeyCtrlJ:
		if len(m.pending) > 0 {
			return nil
		}
	case tea.KeyEnter:
		if msg.Alt || !m.normalSize() {
			return nil
		}
		if len(m.pending) > 0 {
			m.answer(strings.TrimSpace(m.input.Value()))
			return nil
		}
		if m.busy() {
			return nil
		}
		text := strings.TrimSpace(m.input.Value())
		switch text {
		case "":
			return nil
		case "/exit", "/quit":
			return tea.Quit
		case "/help":
			m.note(entryNotice, "Enter sends, Ctrl+J adds a line, PgUp/PgDn scrolls, Ctrl+C cancels or quits, /quit exits.")
			m.input.Reset()
			return nil
		}
		m.input.Reset()
		m.start(text)
		return m.spinner.Tick
	}
	if !m.normalSize() || (m.busy() && len(m.pending) == 0) {
		return nil
	}
	return m.updateInput(msg)
}

package tui

import (
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

type entryKind uint8

const (
	entryUser entryKind = iota
	entryAgent
	entryTool
	entryQuestion
	entryNotice
	entryError
)

// entry 是一条转录。rendered 缓存当前会话宽度下的渲染结果，
// 宽度变化时置空重算。
type entry struct {
	kind     entryKind
	text     string
	rendered string
}

// theme 使用终端自身背景，Loopra 蓝为强调色，
// 审批用暖琥珀与正文拉开层级。
type theme struct {
	brand, accent, muted, user, warning, danger lipgloss.Style
	frame                                       lipgloss.Style
}

func newTheme(output io.Writer) theme {
	r := lipgloss.NewRenderer(output)
	blue := lipgloss.AdaptiveColor{Light: "#3647BA", Dark: "#9AA5FF"}
	muted := lipgloss.AdaptiveColor{Light: "#555A70", Dark: "#A1A8B9"}
	surface := lipgloss.AdaptiveColor{Light: "#EEF0FA", Dark: "#20243C"}
	ink := lipgloss.AdaptiveColor{Light: "#202646", Dark: "#E9ECFF"}
	warning := lipgloss.AdaptiveColor{Light: "#8F4F00", Dark: "#FFC16B"}
	danger := lipgloss.AdaptiveColor{Light: "#A33531", Dark: "#FF938D"}
	return theme{
		brand:   r.NewStyle().Bold(true),
		accent:  r.NewStyle().Foreground(blue),
		muted:   r.NewStyle().Foreground(muted),
		user:    r.NewStyle().Background(surface).Foreground(ink),
		warning: r.NewStyle().Foreground(warning),
		danger:  r.NewStyle().Foreground(danger),
		frame:   r.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(blue).Padding(0, 1),
	}
}

// composerHeight 在较矮终端里给单行输入，否则给三行。
func composerHeight(height int) int {
	if height < 16 {
		return 1
	}
	return 3
}

// columnWidth 是主栏宽度：窄窗口全宽，超过 28 后留两格边距，
// 上限 96 单元。
func columnWidth(width int) int {
	if width > 28 {
		width -= 4
	}
	return min(96, max(1, width))
}

func (t theme) renderEntry(e entry, width int) string {
	if width < 4 {
		return ansi.Hardwrap(e.text, width, true)
	}
	wrapped := ansi.Hardwrap(e.text, width-3, true)
	lines := strings.Split(wrapped, "\n")
	for i, line := range lines {
		switch e.kind {
		case entryUser:
			lines[i] = t.accent.Render("▎") + t.user.Width(width-1).Render(" "+line)
		case entryQuestion:
			lines[i] = t.warning.Render("│") + " " + line
			if i == 0 {
				lines[i] = t.warning.Bold(true).Render("│ " + line)
			}
		case entryTool:
			mark := "  "
			if i == 0 {
				mark = "· "
			}
			lines[i] = t.muted.Render(mark + line)
		case entryNotice:
			lines[i] = t.muted.Render("  " + line)
		case entryError:
			lines[i] = t.danger.Render("  " + line)
		default:
			lines[i] = "  " + line
		}
	}
	return strings.Join(lines, "\n")
}

// tail 保留 text 末尾至多 width 个单元，从左边截断，
// 让路径当前目录保持可见。
func tail(text string, width int) string {
	if width <= 0 {
		return ""
	}
	over := ansi.StringWidth(text) - width + 1 // room for the "…" marker
	if over <= 0 {
		return text
	}
	return ansi.TruncateLeft(text, over, "…")
}

// header 空闲时是右对齐的路径；有内容后左侧字标、右侧路径尾。
func (m *model) header() string {
	width := m.viewport.Width
	if len(m.entries) == 0 {
		cwd := tail(m.cwd, width)
		return strings.Repeat(" ", max(0, width-ansi.StringWidth(cwd))) + m.styles.muted.Render(cwd)
	}
	label := m.styles.accent.Render("└─") + " " + m.styles.brand.Render("Loopra")
	cwd := tail(m.cwd, width-ansi.StringWidth(label)-2)
	padding := strings.Repeat(" ", max(0, width-ansi.StringWidth(label)-ansi.StringWidth(cwd)))
	return label + padding + m.styles.muted.Render(cwd)
}

// welcome 是空会话时居中的小标记：框线里的 "L 回环"，旁边展开字标。
func (m *model) welcome() string {
	width, height := m.viewport.Width, m.viewport.Height
	mark := m.styles.brand.Render("L O O P R A")
	if height >= 3 {
		loop := m.styles.accent.Render("╭─────╮\n│ └─  │\n╰─────╯")
		mark = lipgloss.JoinHorizontal(lipgloss.Center, loop, "  "+mark)
	}
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, mark)
}

// composer 是底部固定输入框：轮次进行中显示状态，
// 有待答问题时边框转琥珀色。
func (m *model) composer() string {
	inner := m.viewport.Width - 4 // two borders, two pad cells
	body := m.input.View()
	frame := m.styles.frame
	switch {
	case len(m.pending) > 0:
		frame = frame.BorderForeground(m.styles.warning.GetForeground())
	case m.busy():
		status := "Responding"
		if m.stopping {
			status = "Cancelling"
		}
		body = " " + m.spinner.View() + " " + status
	}
	return frame.Width(inner + 2).Height(m.input.Height()).Render(body)
}

// footer 一行按键栏：左侧空间够时放当前模型，右侧放按键提示。
func (m *model) footer() string {
	var hint, compact string
	switch {
	case len(m.pending) > 0 && m.pending[0].count > 0:
		hint, compact = "Enter choose  ·  Esc cancel  ·  PgUp/Dn scroll", "Enter choose  Esc cancel"
	case len(m.pending) > 0:
		hint, compact = "y + Enter allow once  ·  Esc deny  ·  PgUp/Dn scroll", "y+Enter allow  Esc deny"
	case m.stopping:
		hint, compact = "Ctrl+C quit  ·  PgUp/Dn scroll", "Ctrl+C quit"
	case m.busy():
		hint, compact = "Ctrl+C cancel  ·  PgUp/Dn scroll", "Ctrl+C cancel"
	default:
		hint, compact = "Enter send  ·  Ctrl+J newline  ·  /help", "Enter send  ·  /help"
	}
	width := m.viewport.Width
	if ansi.StringWidth(hint) > width {
		hint = compact
	}
	hint = ansi.Truncate(hint, width, "…")
	room := width - ansi.StringWidth(hint)
	left := ""
	if room >= 12 {
		left = ansi.Truncate(m.modelName, room-2, "…")
	}
	return m.styles.muted.Render(left + strings.Repeat(" ", max(0, room-ansi.StringWidth(left))) + hint)
}

func (m *model) View() string {
	if !m.normalSize() {
		return ansi.Truncate("Enlarge the terminal", max(1, m.width), "…")
	}
	body := m.viewport.View()
	if len(m.entries) == 0 {
		body = m.welcome()
	}
	view := m.header() + "\n\n" + body + "\n" + m.composer() + "\n" + m.footer()
	pad := strings.Repeat(" ", max(0, (m.width-m.viewport.Width)/2))
	return pad + strings.ReplaceAll(view, "\n", "\n"+pad)
}

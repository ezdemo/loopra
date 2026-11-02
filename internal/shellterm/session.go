package shellterm

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/egoist/mygo/plugins/terminal"
)

const (
	defaultCols  = 80
	defaultRows  = 24
	defaultCellW = 8
	defaultCellH = 16
	minCols      = 2
	minRows      = 1
	maxCols      = 500
	maxRows      = 200
)

// Session is one interactive shell. The emulator has no native view, so each
// page attachment gets a Mirror of the same screen.
type Session struct {
	ID    string
	Title string
	Dir   string
	Shell string

	mu       sync.Mutex
	term     *terminal.Terminal
	done     chan struct{}
	exitCode int
	exited   bool
	closed   bool
	cols     int
	rows     int
}

// Open starts the user login shell in dir.
func Open(id, dir string) (*Session, error) {
	if err := terminal.Load(); err != nil {
		return nil, err
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("工作目录不存在")
	}
	name := shellName()
	s := &Session{
		ID: id, Title: name, Dir: dir, Shell: name,
		done: make(chan struct{}), cols: defaultCols, rows: defaultRows,
	}
	term, err := terminal.New(terminal.Options{
		Dir:       dir,
		Theme:     terminal.DarkTheme(),
		DarkTheme: terminal.DarkTheme(),
		Cursor:    terminal.CursorBar,
		NoBlink:   true,
		OnTitle:   func(title string) { s.setTitle(title) },
		OnExit:    func(code int) { s.markExit(code) },
	})
	if err != nil {
		return nil, err
	}
	s.term = term
	term.ResizePixels(defaultCols, defaultRows, defaultCellW, defaultCellH)
	go func() {
		<-term.Done()
		s.markExit(term.ExitCode())
	}()
	return s, nil
}

func (s *Session) setTitle(title string) {
	title = strings.TrimSpace(title)
	if title == "" {
		return
	}
	s.mu.Lock()
	s.Title = title
	s.mu.Unlock()
}

func (s *Session) markExit(code int) {
	s.mu.Lock()
	if !s.exited {
		s.exited, s.exitCode = true, code
		close(s.done)
	}
	s.mu.Unlock()
}

// Done is closed when the shell exits.
func (s *Session) Done() <-chan struct{} { return s.done }

// Write types into the shell.
func (s *Session) Write(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	s.mu.Lock()
	term, closed, exited := s.term, s.closed, s.exited
	s.mu.Unlock()
	if closed || exited || term == nil {
		return io.EOF
	}
	term.Send(data)
	return nil
}

// Resize changes the shell and the mirrored screen together.
func (s *Session) Resize(cols, rows, cellW, cellH int) error {
	cols, rows = clampSize(cols, rows)
	if cellW < 4 {
		cellW = defaultCellW
	}
	if cellH < 8 {
		cellH = defaultCellH
	}
	s.mu.Lock()
	term, closed := s.term, s.closed
	if !closed {
		s.cols, s.rows = cols, rows
	}
	s.mu.Unlock()
	if closed || term == nil {
		return io.EOF
	}
	term.ResizePixels(cols, rows, cellW, cellH)
	return nil
}

// Clear clears the scrollback and the screen above the prompt.
func (s *Session) Clear() {
	s.mu.Lock()
	term := s.term
	s.mu.Unlock()
	if term != nil {
		term.ClearScreen()
	}
}

// Mirror returns a viewer of this shell. Each page attachment needs its own.
func (s *Session) Mirror() (*terminal.Mirror, error) {
	s.mu.Lock()
	term, closed := s.term, s.closed
	s.mu.Unlock()
	if closed || term == nil {
		return nil, io.EOF
	}
	return term.NewMirror()
}

// Info is the session as the page lists it.
func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := Info{ID: s.ID, Title: s.Title, Shell: s.Shell, Cwd: s.Dir, Cols: s.cols, Rows: s.rows, Exited: s.exited, ExitCode: s.exitCode}
	if s.term != nil {
		if cwd := strings.TrimSpace(s.term.Dir()); cwd != "" {
			info.Cwd = cwd
		}
	}
	return info
}

// Close hangs up the shell and frees the emulator.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	term := s.term
	s.term = nil
	s.mu.Unlock()
	if term != nil {
		_ = term.Close()
	}
	s.markExit(-1)
}

// Info describes a shell session without its screen.
type Info struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Shell    string `json:"shell"`
	Cwd      string `json:"cwd"`
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
	Exited   bool   `json:"exited"`
	ExitCode int    `json:"exitCode"`
}

func clampSize(cols, rows int) (int, int) {
	if cols < minCols {
		cols = defaultCols
	}
	if rows < minRows {
		rows = defaultRows
	}
	if cols > maxCols {
		cols = maxCols
	}
	if rows > maxRows {
		rows = maxRows
	}
	return cols, rows
}

func shellName() string {
	if runtime.GOOS == "windows" {
		for _, candidate := range []string{"pwsh.exe", "powershell.exe", os.Getenv("COMSPEC"), "cmd.exe"} {
			if candidate == "" {
				continue
			}
			if _, err := exec.LookPath(candidate); err != nil {
				continue
			}
			base := strings.TrimSuffix(strings.ToLower(filepath.Base(candidate)), ".exe")
			if base == "cmd" || strings.Contains(strings.ToLower(candidate), "cmd.exe") {
				return "cmd"
			}
			return "powershell"
		}
		return "shell"
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		if runtime.GOOS == "darwin" {
			return "zsh"
		}
		return "sh"
	}
	return filepath.Base(shell)
}

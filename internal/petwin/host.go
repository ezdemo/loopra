package petwin

import (
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/ezdemo/looprax/internal/petdesk"
	"github.com/ezdemo/looprax/internal/repository"
)

// Host draws the pet in a frameless native window. The workbench, whether it
// is the desktop shell or a browser on loopra web, only sends petdesk.State.
type Host struct {
	mu        sync.Mutex
	fileMu    sync.Mutex
	home      string
	petsDir   string
	parent    *mygo.Window
	win       *mygo.Window
	ready     bool
	want      bool
	reset     bool
	state     petdesk.State
	onDismiss func()
	dismissed atomic.Uint64

	theme    *ui.Theme
	paper    ui.Color
	bitmap   *ui.Bitmap
	cellW    int
	cellH    int
	cols     int
	rows     int
	petName  string
	label    string
	sheetErr string

	scale        float64
	remoteScale  float64
	activity     string
	replyID      string
	latestReply  string
	speech       string
	speechUntil  time.Time
	oneshot      string
	oneshotUntil time.Time
	nextIdle     time.Time
	animName     string
	animStart    time.Time

	controls  bool
	confirm   bool
	stale     bool
	anchorX   int
	anchorY   int
	pressAX   int
	pressAY   int
	frameX    int
	frameY    int
	frameW    int
	frameH    int
	pop       *mygo.Window
	popX      int
	popY      int
	popW      int
	popH      int
	popQueued bool

	down     bool
	dragging bool
	dragLeft bool
	consumed bool
	pressAt  time.Time
	pressX   int
	pressY   int
}

// New prepares a host. The window is created later, from Attach, once mygo is running.
func New(home, petsDir string) *Host {
	if petsDir == "" {
		if user, err := os.UserHomeDir(); err == nil {
			petsDir = filepath.Join(user, ".petdex", "pets")
		}
	}
	return &Host{home: home, petsDir: petsDir, scale: 0.55, activity: "idle"}
}

// WhenDismissed runs after the user confirms closing the pet.
// The callback runs on the UI thread and must not wait on it.
func (h *Host) WhenDismissed(fn func()) {
	h.mu.Lock()
	h.onDismiss = fn
	h.mu.Unlock()
}

// Dismissed counts confirmed closes. A client that has not seen the latest
// count is ignored when it asks to show the pet again.
func (h *Host) Dismissed() uint64 { return h.dismissed.Load() }

// Ready reports that Attach has run and the window can be shown.
func (h *Host) Ready() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ready
}

// Attach is called on the UI thread once the application is ready.
// parent keeps the pet above the workbench; nil floats it above other apps
// so a browser running against loopra web does not cover it.
func (h *Host) Attach(parent *mygo.Window) {
	h.mu.Lock()
	h.parent = parent
	h.ready = true
	want := h.want
	reset := h.reset
	h.mu.Unlock()
	if want {
		h.show()
	}
	if reset {
		h.resetOrigin()
	}
}

// Present shows the pet and applies state. It is safe from any goroutine.
func (h *Host) Present(state petdesk.State) {
	h.mu.Lock()
	h.want = true
	h.state = state
	ready := h.ready
	h.mu.Unlock()
	if ready {
		mygo.RunOnMain(h.show)
	}
}

// Hide keeps the window alive and takes it off screen.
func (h *Host) Hide() {
	h.mu.Lock()
	h.want = false
	ready := h.ready
	h.mu.Unlock()
	if ready {
		mygo.RunOnMain(func() {
			h.hideWindows()
		})
	}
}

// Reset parks the pet at the bottom-right of the primary display.
func (h *Host) Reset() {
	h.mu.Lock()
	h.reset = true
	ready := h.ready
	h.mu.Unlock()
	if ready {
		mygo.RunOnMain(h.resetOrigin)
	}
}

func (h *Host) show() {
	// A press is in progress. Rebuilding now removes the element that owns
	// the pointer, so the release never arrives and the pet keeps dragging.
	if h.down {
		h.stale = true
		return
	}
	h.stale = false
	h.applyState()
	if h.win != nil && !h.win.IsDestroyed() {
		if h.want && !h.win.IsVisible() {
			h.win.ShowInactive()
		}
		// The bubble lives in its own window, so this never moves the pet.
		h.placePet()
		h.syncPop()
		h.win.Invalidate()
		return
	}
	h.open()
}

func (h *Host) applyState() {
	h.mu.Lock()
	state := h.state
	h.mu.Unlock()
	if state.Scale >= 0.25 && state.Scale <= 1.25 && state.Scale != h.remoteScale {
		h.remoteScale = state.Scale
		h.scale = state.Scale
	}
	if h.scale == 0 {
		h.scale = 0.55
	}
	h.activity = knownActivity(state.Activity)
	if state.Label != "" {
		h.label = state.Label
	} else {
		h.label = state.Name
	}
	if state.Name != "" && state.Name != h.petName {
		h.loadSheet(state.Name)
	}
	if state.ReplyID != "" && state.ReplyID != h.replyID {
		h.replyID = state.ReplyID
		if state.Reply != "" {
			h.say(state.Reply)
			h.play(state.ReplyActivity)
		}
	}
	if state.Latest != "" {
		h.latestReply = state.Latest
	}
	if h.win != nil && h.label != "" {
		h.win.SetTitle(h.label)
	}
}

func (h *Host) open() {
	if !h.want {
		return
	}
	width, height := h.petBox()
	if ax, ay, ok := h.savedAnchor(); ok {
		h.anchorX, h.anchorY = int(math.Round(ax)), int(math.Round(ay))
	} else {
		x, y := h.defaultCorner(width, height)
		h.anchorX, h.anchorY = x+width, y+height
	}
	x, y := h.petOrigin(width, height)
	parent := h.parent
	if parent != nil && parent.IsDestroyed() {
		parent = nil
	}
	win := h.chrome(parent, parent == nil, x, y, width, height, h.view)
	h.win = win
	h.frameX, h.frameY, h.frameW, h.frameH = x, y, width, height
	h.anchorX, h.anchorY = x+width, y+height
	if h.want {
		win.ShowInactive()
	} else {
		win.Hide()
	}
	h.syncPop()
}

func (h *Host) chrome(parent *mygo.Window, onTop bool, x, y, width, height int, view func(*ui.Context)) *mygo.Window {
	// Set an explicit minimum so Windows does not apply its default
	// tracking size to this small, non-resizable window.
	win := mygo.NewWindow(mygo.WindowOptions{
		Title:             h.displayName(),
		X:                 x,
		Y:                 y,
		Width:             width,
		Height:            height,
		MinWidth:          1,
		MinHeight:         1,
		UseContentSize:    true,
		Frameless:         true,
		Transparent:       true,
		BackgroundColor:   "transparent",
		DisableResize:     true,
		DisableMaximize:   true,
		DisableMinimize:   true,
		DisableFullScreen: true,
		DisableShadow:     true,
		DisableClose:      true,
		SkipTaskbar:       true,
		Hidden:            true,
		AlwaysOnTop:       onTop,
		Parent:            parent,
		Content:           ui.View(view),
	})
	win.SetContentBounds(mygo.Rectangle{X: x, Y: y, Width: width, Height: height})
	return win
}

func (h *Host) view(c *ui.Context) {
	h.ensureTheme(c)
	// The OS may still enlarge a frameless window beyond its requested
	// size. Keep the sprite at the origin used by petOrigin/popOrigin,
	// rather than shifting it into that extra (possibly off-screen) space.
	ui.Box(c).Grow(1).Justify(ui.Start).AlignItems(ui.Start).Children(func() {
		h.sprite(c)
	})
}

func (h *Host) popView(c *ui.Context) {
	h.ensureTheme(c)
	ui.Box(c).Grow(1).Justify(ui.End).AlignItems(ui.End).Children(func() {
		h.overlay(c)
	})
}

func (h *Host) ensureTheme(c *ui.Context) {
	if h.theme == nil {
		theme := *c.Theme()
		h.paper = theme.Background
		theme.Background = ui.Transparent
		h.theme = &theme
	}
	c.SetTheme(h.theme)
}

func (h *Host) overlay(c *ui.Context) {
	theme := c.Theme()
	switch {
	case h.controls && h.confirm:
		ui.Box(c).Width(panelWidth).Padding(12).Gap(8).Background(theme.Surface).Radius(12).Children(func() {
			ui.Text(c, "关闭宠物？")
			ui.Text(c, "可以在设置 → 偏好设置 → 宠物中重新开启。").FontSize(12).TextColor(theme.TextMuted)
			ui.Row(c).Gap(8).Children(func() {
				if ui.Button(c, "取消").Clicked() {
					h.confirm = false
					h.relayout()
				}
				if ui.Button(c, "关闭").Clicked() {
					h.dismiss()
				}
			})
		})
	case h.controls:
		ui.Box(c).Width(panelWidth).Padding(12).Gap(8).Background(theme.Surface).Radius(12).Children(func() {
			ui.Row(c).AlignItems(ui.Center).Children(func() {
				ui.Text(c, h.displayName()).Grow(1)
				if ui.Button(c, "收起").Clicked() {
					h.controls = false
					h.relayout()
				}
			})
			ui.Text(c, "宠物大小").FontSize(12).TextColor(theme.TextMuted)
			if ui.Slider(c, &h.scale, 0.25, 1.25).Label("宠物大小").Changed() {
				h.scale = clampScale(h.scale)
				h.relayout()
				h.persistScale(h.scale)
			}
			ui.Row(c).Gap(8).Wrap().Children(func() {
				if ui.Button(c, "重置位置").Clicked() {
					h.resetOrigin()
				}
				if ui.Button(c, "关闭宠物").Clicked() {
					h.confirm = true
					h.relayout()
				}
			})
			ui.Text(c, "点击互动 · 双击跳跃 · 拖动移动").FontSize(12).TextColor(theme.TextMuted)
			ui.Text(c, "方向键微调 · Home 回到屏幕右下角").FontSize(12).TextColor(theme.TextMuted)
		})
	case h.speech != "" && time.Now().Before(h.speechUntil):
		fill, ink := theme.Inverse, theme.InverseText
		if fill == (ui.Color{}) {
			fill = theme.Text
		}
		if ink == (ui.Color{}) {
			ink = h.paper
		}
		ui.Box(c).Width(panelWidth).Padding(10).Gap(6).Background(fill).Radius(12).Children(func() {
			ui.Text(c, h.speech).TextColor(ink)
			if ui.Button(c, "关闭").Clicked() {
				h.speech = ""
				h.relayout()
			}
		})
	}
}

func (h *Host) sprite(c *ui.Context) {
	width, height := spriteSize(h.scale)
	cursor := ui.CursorPointer
	if h.dragging {
		cursor = ui.CursorGrabbing
	}
	// Key keeps this element across bubble and panel changes, so the press
	// still receives its release after the dialog appears.
	box := ui.Box(c.Key("pet")).Size(float32(width), float32(height)).Cursor(cursor).Focusable().Label("宠物：" + h.displayName())
	box.HandleInput(h.input)
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		now := p.Now()
		h.tick(now)
		row, col, wait := h.frameOf(now)
		p.After(wait)
		if h.bitmap == nil || h.cellW < 1 || h.cellH < 1 {
			p.Text(r.X, r.Y+r.H/2, h.sheetMessage(), 12, p.Theme().TextMuted)
			return
		}
		if col >= h.cols {
			col = h.cols - 1
		}
		if row >= h.rows {
			row = h.rows - 1
		}
		src := ui.Rect{X: float32(col * h.cellW), Y: float32(row * h.cellH), W: float32(h.cellW), H: float32(h.cellH)}
		p.ImageRegion(h.bitmap, src, r, ui.ImageOptions{})
	})
}

func (h *Host) input(ev ui.InputEvent) bool {
	switch ev.Kind {
	case ui.InputPointerDown:
		if ev.Button == 1 {
			h.controls = true
			h.confirm = false
			h.relayout()
			return true
		}
		if ev.Button != 0 {
			return false
		}
		h.down = true
		h.dragging = false
		h.consumed = ev.Clicks >= 2
		h.pressAt = ev.Time
		point := mygo.Screen.CursorScreenPoint()
		h.pressX, h.pressY = point.X, point.Y
		h.pressAX, h.pressAY = h.anchorX, h.anchorY
		if ev.Clicks >= 2 {
			h.play("jumping")
		}
		return true
	case ui.InputPointerMove:
		// Button -1 means the button is up. The dialog rebuild can drop the
		// captured press; without this, later moves keep dragging.
		if ev.Button < 0 {
			if h.down {
				h.cancelPress()
			}
			return false
		}
		if !h.down || h.win == nil {
			return false
		}
		if h.consumed && !h.dragging {
			return true
		}
		point := mygo.Screen.CursorScreenPoint()
		dx, dy := point.X-h.pressX, point.Y-h.pressY
		if !h.dragging && absInt(dx)+absInt(dy) <= 4 {
			return true
		}
		h.dragging = true
		h.dragLeft = dx < 0
		h.consumed = true
		h.anchorX, h.anchorY = h.pressAX+dx, h.pressAY+dy
		h.placePet()
		h.positionPop()
		return true
	case ui.InputPointerUp:
		if ev.Button != 0 || !h.down {
			return true
		}
		h.finishPress()
		return true
	case ui.InputKeyDown:
		return h.key(ev)
	default:
		return false
	}
}

func (h *Host) key(ev ui.InputEvent) bool {
	if ev.Key == ui.KeyEscape {
		h.controls = false
		h.confirm = false
		h.speech = ""
		h.relayout()
		return true
	}
	if ev.Key == ui.KeyContextMenu || (ev.Mods&ui.Shift != 0 && ev.Key == ui.KeyF10) {
		h.controls = true
		h.confirm = false
		h.relayout()
		return true
	}
	if ev.Key == ui.KeyHome {
		h.resetOrigin()
		return true
	}
	step := 10
	if ev.Mods&ui.Shift != 0 {
		step = 40
	}
	dx, dy := 0, 0
	switch ev.Key {
	case ui.KeyLeft:
		dx = -step
	case ui.KeyRight:
		dx = step
	case ui.KeyUp:
		dy = -step
	case ui.KeyDown:
		dy = step
	default:
		return false
	}
	if h.win == nil {
		return true
	}
	h.anchorX += dx
	h.anchorY += dy
	h.placePet()
	h.positionPop()
	h.persistAnchor()
	return true
}

func (h *Host) tick(now time.Time) {
	if h.down && !h.dragging && !h.controls && !now.Before(h.pressAt.Add(500*time.Millisecond)) {
		h.controls = true
		h.confirm = false
		h.consumed = true
		h.relayout()
	}
	if h.speech != "" && !h.down && !now.Before(h.speechUntil) {
		h.speech = ""
		h.relayout()
	}
	if h.dragging || h.activity != "idle" || (h.oneshot != "" && now.Before(h.oneshotUntil)) {
		return
	}
	if h.nextIdle.IsZero() {
		h.nextIdle = now.Add(idleDelay())
		return
	}
	if !now.Before(h.nextIdle) {
		h.play(idleActions[rand.IntN(len(idleActions))])
		h.nextIdle = time.Time{}
	}
}

func (h *Host) frameOf(now time.Time) (row, col int, wait time.Duration) {
	name := h.activity
	if h.dragging {
		name = "running-right"
		if h.dragLeft {
			name = "running-left"
		}
	} else if h.oneshot != "" && now.Before(h.oneshotUntil) {
		name = h.oneshot
	}
	name = knownActivity(name)
	if name != h.animName {
		h.animName = name
		h.animStart = now
	}
	spec := animations[name]
	elapsed := int(now.Sub(h.animStart) / time.Millisecond)
	col = frameColumn(name, elapsed)
	into := elapsed
	total := 0
	for _, d := range spec.durations {
		total += d
	}
	if total > 0 {
		into = elapsed % total
	}
	remain := spec.durations[col]
	for _, d := range spec.durations[:col] {
		into -= d
	}
	remain -= into
	if remain < 16 {
		remain = 16
	}
	return spec.row, col, time.Duration(remain) * time.Millisecond
}

func (h *Host) finishPress() {
	dragged := h.dragging
	consumed := h.consumed
	h.down = false
	h.dragging = false
	h.consumed = false
	if dragged {
		h.dismissOverlay()
		h.persistAnchor()
	} else if !consumed {
		h.play("waving")
		text := h.latestReply
		if text == "" {
			text = "你好，我是 " + h.displayName() + "。可以拖动我，右键打开设置。"
		}
		h.say(text)
	}
	if h.stale {
		h.show()
	}
}

func (h *Host) cancelPress() {
	dragged := h.dragging
	h.down = false
	h.dragging = false
	h.consumed = false
	if dragged {
		h.dismissOverlay()
		h.persistAnchor()
	}
	if h.stale {
		h.show()
	} else if dragged {
		h.invalidate()
	}
}

func (h *Host) dismissOverlay() {
	h.speech = ""
	h.controls = false
	h.confirm = false
	h.relayout()
}

func (h *Host) invalidate() {
	if h.win != nil && !h.win.IsDestroyed() {
		h.win.Invalidate()
	}
}

func (h *Host) play(name string) {
	name = knownActivity(name)
	if name == "idle" {
		name = "waving"
	}
	h.oneshot = name
	h.oneshotUntil = time.Now().Add(time.Duration(animationLength(name)) * time.Millisecond)
	h.animName = ""
}

func (h *Host) say(text string) {
	h.speech = text
	h.speechUntil = time.Now().Add(8 * time.Second)
	h.controls = false
	h.relayout()
}

func (h *Host) dismiss() {
	h.mu.Lock()
	h.want = false
	fn := h.onDismiss
	h.mu.Unlock()
	h.dismissed.Add(1)
	h.controls = false
	h.confirm = false
	h.hideWindows()
	if fn != nil {
		fn()
	}
}

func (h *Host) displayName() string {
	if h.label != "" {
		return h.label
	}
	if h.petName != "" {
		return h.petName
	}
	return "宠物"
}

func (h *Host) sheetMessage() string {
	if h.sheetErr != "" {
		return "图片加载失败"
	}
	return "正在加载宠物"
}

func (h *Host) petBox() (int, int) {
	return frameSize(h.scale, 0)
}

func (h *Host) petOrigin(width, height int) (int, int) {
	return clampToAreas(h.anchorX-width, h.anchorY-height, width, height, edgeKeep, workAreas())
}

func (h *Host) popBox() (int, int, bool) {
	switch {
	case h.controls && h.confirm:
		return panelWidth, confirmExtra, true
	case h.controls:
		return panelWidth, controlsExtra, true
	case h.speech != "" && time.Now().Before(h.speechUntil):
		return panelWidth, speechExtra, true
	default:
		return 0, 0, false
	}
}

func (h *Host) placePet() {
	if h.win == nil || h.win.IsDestroyed() {
		return
	}
	width, height := h.petBox()
	x, y := h.petOrigin(width, height)
	h.anchorX, h.anchorY = x+width, y+height
	if x == h.frameX && y == h.frameY && width == h.frameW && height == h.frameH {
		return
	}
	h.frameX, h.frameY, h.frameW, h.frameH = x, y, width, height
	h.win.SetContentBounds(mygo.Rectangle{X: x, Y: y, Width: width, Height: height})
}

func (h *Host) relayout() {
	if h.win == nil || h.win.IsDestroyed() || h.popQueued {
		return
	}
	h.popQueued = true
	win := h.win
	win.Update(func() {
		h.popQueued = false
		if h.win != win || h.win.IsDestroyed() {
			return
		}
		h.placePet()
		h.syncPop()
	})
}

func (h *Host) syncPop() {
	width, height, open := h.popBox()
	if !open || h.frameW < 1 {
		if h.pop != nil && !h.pop.IsDestroyed() {
			h.pop.Hide()
		}
		return
	}
	x, y := popOrigin(h.frameX, h.frameY, h.frameW, h.frameH, width, height)
	if h.pop == nil || h.pop.IsDestroyed() {
		onTop := h.parent == nil || h.parent.IsDestroyed()
		h.pop = h.chrome(h.win, onTop, x, y, width, height, h.popView)
		h.popX, h.popY, h.popW, h.popH = x, y, width, height
		h.pop.ShowInactive()
		return
	}
	if x != h.popX || y != h.popY || width != h.popW || height != h.popH {
		h.popX, h.popY, h.popW, h.popH = x, y, width, height
		h.pop.SetContentBounds(mygo.Rectangle{X: x, Y: y, Width: width, Height: height})
	}
	if !h.pop.IsVisible() {
		h.pop.ShowInactive()
	}
	h.pop.Invalidate()
}

func (h *Host) positionPop() {
	if h.pop == nil || h.pop.IsDestroyed() || !h.pop.IsVisible() {
		return
	}
	width, height, open := h.popBox()
	if !open {
		return
	}
	x, y := popOrigin(h.frameX, h.frameY, h.frameW, h.frameH, width, height)
	if x == h.popX && y == h.popY && width == h.popW && height == h.popH {
		return
	}
	h.popX, h.popY, h.popW, h.popH = x, y, width, height
	h.pop.SetContentBounds(mygo.Rectangle{X: x, Y: y, Width: width, Height: height})
}

func (h *Host) hideWindows() {
	if h.win != nil && !h.win.IsDestroyed() {
		h.win.Hide()
	}
	if h.pop != nil && !h.pop.IsDestroyed() {
		h.pop.Hide()
	}
}

func (h *Host) resetOrigin() {
	h.mu.Lock()
	h.reset = false
	h.mu.Unlock()
	if h.win == nil || h.win.IsDestroyed() {
		return
	}
	width, height := h.petBox()
	x, y := h.defaultCorner(width, height)
	h.anchorX, h.anchorY = x+width, y+height
	h.placePet()
	h.syncPop()
	h.persistAnchor()
}

func (h *Host) defaultCorner(width, height int) (int, int) {
	area := mygo.Screen.PrimaryDisplay().WorkArea
	return defaultOrigin(rect{area.X, area.Y, area.Width, area.Height}, width, height)
}

func (h *Host) loadSheet(name string) {
	h.petName = name
	h.bitmap = nil
	h.sheetErr = ""
	h.cellW, h.cellH, h.cols, h.rows = 0, 0, 0, 0
	path := filepath.Join(h.petsDir, name, "spritesheet.webp")
	data, err := os.ReadFile(path)
	if err != nil {
		h.sheetErr = err.Error()
		return
	}
	bitmap, err := ui.DecodeBitmap(data)
	if err != nil {
		h.sheetErr = err.Error()
		return
	}
	w, ht := bitmap.Size()
	h.bitmap = bitmap
	h.cellW, h.cellH, h.cols, h.rows = atlasGrid(w, ht)
}

func (h *Host) positionPath() string {
	return filepath.Join(h.home, "pet", "position.json")
}

func (h *Host) savedAnchor() (float64, float64, bool) {
	doc := repository.ReadObject(h.positionPath())
	x, xOK := asFloat(doc["desktopX"])
	y, yOK := asFloat(doc["desktopY"])
	return x, y, xOK && yOK
}

func (h *Host) persistAnchor() {
	if h.frameW < 1 || h.frameH < 1 {
		return
	}
	h.mergePosition(func(doc map[string]any) {
		doc["desktopX"] = h.anchorX
		doc["desktopY"] = h.anchorY
	})
}

func (h *Host) persistScale(scale float64) {
	h.mergePosition(func(doc map[string]any) {
		doc["scale"] = scale
	})
}

func (h *Host) mergePosition(update func(map[string]any)) {
	go func() {
		h.fileMu.Lock()
		defer h.fileMu.Unlock()
		path := h.positionPath()
		doc := repository.ReadObject(path)
		update(doc)
		_ = repository.WriteJSON(path, doc)
	}()
}

func workAreas() []rect {
	displays := mygo.Screen.Displays()
	areas := make([]rect, 0, len(displays))
	for _, display := range displays {
		area := display.WorkArea
		areas = append(areas, rect{area.X, area.Y, area.Width, area.Height})
	}
	return areas
}

func asFloat(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return 0, false
		}
		return n, true
	case int:
		return float64(n), true
	default:
		return 0, false
	}
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func idleDelay() time.Duration {
	return 4*time.Second + time.Duration(rand.IntN(8000))*time.Millisecond
}

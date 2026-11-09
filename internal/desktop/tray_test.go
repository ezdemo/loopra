package desktop

import (
	"reflect"
	"testing"

	"github.com/egoist/mygo"
)

type testBackgroundWindow struct {
	minimized bool
	actions   []string
}

func (w *testBackgroundWindow) Hide()             { w.actions = append(w.actions, "hide") }
func (w *testBackgroundWindow) Show()             { w.actions = append(w.actions, "show") }
func (w *testBackgroundWindow) Focus()            { w.actions = append(w.actions, "focus") }
func (w *testBackgroundWindow) IsMinimized() bool { return w.minimized }
func (w *testBackgroundWindow) Restore() {
	w.minimized = false
	w.actions = append(w.actions, "restore")
}

func TestCloseToTrayKeepsWindowAlive(t *testing.T) {
	window := &testBackgroundWindow{}
	resident := &residentWindow{window: window, trayAvailable: func() bool { return true }}
	for range 2 {
		event := &mygo.CloseEvent{}
		resident.close(event)
		if !event.DefaultPrevented() {
			t.Fatal("close must preserve the window and its page")
		}
		resident.open()
	}
	if want := []string{"hide", "show", "focus", "hide", "show", "focus"}; !reflect.DeepEqual(window.actions, want) {
		t.Fatalf("actions = %v, want %v", window.actions, want)
	}
}

func TestOpenFromTrayRestoresOnlyMinimizedWindow(t *testing.T) {
	for _, minimized := range []bool{false, true} {
		window := &testBackgroundWindow{minimized: minimized}
		resident := &residentWindow{window: window}
		resident.open()
		want := []string{"show", "focus"}
		if minimized {
			want = append([]string{"restore"}, want...)
		}
		if !reflect.DeepEqual(window.actions, want) {
			t.Fatalf("minimized=%v: actions = %v, want %v", minimized, window.actions, want)
		}
	}
}

func TestQuitBypassesCloseToTray(t *testing.T) {
	window := &testBackgroundWindow{}
	resident := &residentWindow{window: window, quitting: true, trayAvailable: func() bool { return true }}
	event := &mygo.CloseEvent{}
	resident.close(event)
	resident.open()
	if event.DefaultPrevented() || len(window.actions) != 0 {
		t.Fatalf("quit must close normally without hiding or reopening: prevented=%v, actions=%v", event.DefaultPrevented(), window.actions)
	}
}

func TestMissingTrayDoesNotHideWindow(t *testing.T) {
	window := &testBackgroundWindow{}
	available := true
	resident := &residentWindow{window: window, trayAvailable: func() bool { return available }}
	// 图标可能在启动后消失，关闭时仍需重新确认。
	resident.close(&mygo.CloseEvent{})
	available = false
	window.actions = nil
	event := &mygo.CloseEvent{}
	resident.close(event)
	if event.DefaultPrevented() || len(window.actions) != 0 {
		t.Fatalf("missing tray must allow normal close: prevented=%v, actions=%v", event.DefaultPrevented(), window.actions)
	}
}

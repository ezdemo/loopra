// Package petdesk is the native pet window as the HTTP server sees it.
// The window itself is drawn by internal/petwin; this package stays free of
// the GUI toolkit so the API can be tested without a display.
package petdesk

// State is what the workbench asks the pet window to show.
type State struct {
	// Name is the pet directory, used to load its spritesheet.
	Name string
	// Label is the name drawn in the panel.
	Label string
	// Activity is the looping animation: idle, running, review, waiting, and the rest of the atlas rows.
	Activity string
	// Reply is a speech bubble. ReplyID changing shows it again.
	Reply         string
	ReplyID       string
	ReplyActivity string
	// Latest is what a click says when no new reply is showing.
	Latest string
	// Scale is the sprite scale, from 0.25 to 1.25. Zero leaves the window's scale alone.
	Scale float64
}

// Surface is the native pet window owned by the process that serves the API.
type Surface interface {
	// Ready reports that the GUI loop is running and can show the window.
	Ready() bool
	Present(State)
	Hide()
	Reset()
	Dismissed() uint64
}

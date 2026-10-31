package petwin

import (
	"image"
	"image/color"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestPetSpriteStaysAtRequestedOrigin(t *testing.T) {
	sheet := image.NewRGBA(image.Rect(0, 0, 1536, 1872))
	for y := 0; y < 208; y++ {
		for x := 0; x < 192; x++ {
			sheet.SetRGBA(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	for _, scale := range []float64{0.25, 0.4, 0.55, 1.25} {
		for _, dpi := range []float32{1, 1.25, 2} {
			h := &Host{scale: scale, activity: "idle", bitmap: ui.NewBitmap(sheet), cellW: 192, cellH: 208, cols: 8, rows: 9}
			w, ht := h.petBox()
			// Windows can enforce a wider minimum size even for a
			// non-resizable, frameless window. Its origin still refers to
			// the requested sprite rectangle, as does the bubble position.
			img := ui.Render(h.view, w+100, ht+40, dpi)
			x, y := int(float32(w/2)*dpi), int(float32(ht/2)*dpi)
			if p := img.RGBAAt(x, y); p.R < 200 || p.G > 20 || p.B > 20 || p.A < 200 {
				t.Fatalf("scale=%v dpi=%v: sprite missing at requested center: %v", scale, dpi, p)
			}
			if p := img.RGBAAt(int(float32(w+50)*dpi), y); p.A != 0 {
				t.Fatalf("scale=%v dpi=%v: sprite shifted into extra window area: %v", scale, dpi, p)
			}
		}
	}
}

package petwin

import "math"

type rect struct{ X, Y, Width, Height int }

type animation struct {
	row       int
	durations []int
}

var animations = map[string]animation{
	"idle":          {0, []int{280, 110, 110, 140, 140, 320}},
	"running-right": {1, []int{120, 120, 120, 120, 120, 120, 120, 220}},
	"running-left":  {2, []int{120, 120, 120, 120, 120, 120, 120, 220}},
	"waving":        {3, []int{140, 140, 140, 280}},
	"jumping":       {4, []int{140, 140, 140, 140, 280}},
	"failed":        {5, []int{140, 140, 140, 140, 140, 140, 140, 240}},
	"waiting":       {6, []int{150, 150, 150, 150, 150, 260}},
	"running":       {7, []int{120, 120, 120, 120, 120, 220}},
	"review":        {8, []int{150, 150, 150, 150, 150, 280}},
}

var idleActions = []string{"running-right", "running-left", "waving", "jumping"}

const (
	panelWidth    = 240
	controlsExtra = 236
	confirmExtra  = 148
	speechExtra   = 248
	edgeKeep      = 48
	cornerMargin  = 24
	popGap        = 8
)

func knownActivity(name string) string {
	if _, ok := animations[name]; ok {
		return name
	}
	return "idle"
}

func animationLength(name string) int {
	total := 0
	for _, d := range animations[knownActivity(name)].durations {
		total += d
	}
	return total
}

// frameColumn is the atlas column for elapsed milliseconds, matching the page pet.
func frameColumn(name string, elapsed int) int {
	spec := animations[knownActivity(name)]
	total := 0
	for _, d := range spec.durations {
		total += d
	}
	if total < 1 {
		return 0
	}
	if elapsed < 0 {
		elapsed = 0
	}
	time := elapsed % total
	for i, d := range spec.durations {
		if time < d {
			return i
		}
		time -= d
	}
	return 0
}

func clampScale(scale float64) float64 {
	if math.IsNaN(scale) || math.IsInf(scale, 0) {
		return 0.55
	}
	if scale < 0.25 {
		return 0.25
	}
	if scale > 1.25 {
		return 1.25
	}
	return scale
}

// spriteSize is the on-screen cell, in DIPs: 192×208 times scale times 0.75.
func spriteSize(scale float64) (float64, float64) {
	scale = clampScale(scale)
	return 192 * scale * 0.75, 208 * scale * 0.75
}

// atlasGrid splits a spritesheet into 8 columns. Petdex sheets are 1536×1872,
// so a cell is 192×208 and there are 9 rows.
func atlasGrid(width, height int) (cellW, cellH, cols, rows int) {
	cols = 8
	if width < cols || height < 1 {
		return 0, 0, 0, 0
	}
	cellW = width / cols
	want := float64(cellW) * 208 / 192
	rows = int(math.Round(float64(height) / want))
	if rows < 1 {
		rows = 1
	}
	cellH = height / rows
	if cellH < 1 {
		cellH = int(math.Round(want))
	}
	if cellH < 1 {
		cellH = 1
	}
	return cellW, cellH, cols, rows
}

func frameSize(scale float64, extra int) (int, int) {
	sw, sh := spriteSize(scale)
	width := int(math.Ceil(sw))
	if extra > 0 && width < panelWidth {
		width = panelWidth
	}
	height := int(math.Ceil(sh)) + extra
	if width < edgeKeep {
		width = edgeKeep
	}
	if height < edgeKeep {
		height = edgeKeep
	}
	return width, height
}

func windowOrigin(anchorX, anchorY float64, width, height int) (int, int) {
	return int(math.Round(anchorX)) - width, int(math.Round(anchorY)) - height
}

// popOrigin places the bubble above the pet, right edges aligned.
// The pet's own rectangle stays where it is.
func popOrigin(petX, petY, petW, petH, popW, popH int) (int, int) {
	return petX + petW - popW, petY - popGap - popH
}

func defaultOrigin(area rect, width, height int) (int, int) {
	return clampToAreas(area.X+area.Width-width-cornerMargin, area.Y+area.Height-height-cornerMargin, width, height, edgeKeep, []rect{area})
}

// clampToAreas keeps at least keep pixels of the window inside the area
// nearest its center. With no areas it returns the point unchanged.
func clampToAreas(x, y, width, height, keep int, areas []rect) (int, int) {
	best, ok := nearestArea(x+width/2, y+height/2, areas)
	if !ok {
		return x, y
	}
	if keep > width {
		keep = width
	}
	if keep > height {
		keep = height
	}
	if keep < 1 {
		keep = 1
	}
	if x > best.X+best.Width-keep {
		x = best.X + best.Width - keep
	}
	if y > best.Y+best.Height-keep {
		y = best.Y + best.Height - keep
	}
	if x+width < best.X+keep {
		x = best.X + keep - width
	}
	if y+height < best.Y+keep {
		y = best.Y + keep - height
	}
	return x, y
}

func nearestArea(x, y int, areas []rect) (rect, bool) {
	best, found := rect{}, false
	bestDist := 0.0
	for _, area := range areas {
		if area.Width <= 0 || area.Height <= 0 {
			continue
		}
		dx, dy := 0.0, 0.0
		if x < area.X {
			dx = float64(area.X - x)
		} else if x > area.X+area.Width {
			dx = float64(x - (area.X + area.Width))
		}
		if y < area.Y {
			dy = float64(area.Y - y)
		} else if y > area.Y+area.Height {
			dy = float64(y - (area.Y + area.Height))
		}
		dist := dx*dx + dy*dy
		if !found || dist < bestDist {
			best, bestDist, found = area, dist, true
		}
	}
	return best, found
}

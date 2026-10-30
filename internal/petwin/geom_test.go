package petwin

import (
	"math"
	"testing"
)

func TestAtlasGridMatchesPetdexSheets(t *testing.T) {
	cellW, cellH, cols, rows := atlasGrid(1536, 1872)
	if cellW != 192 || cellH != 208 || cols != 8 || rows != 9 {
		t.Fatalf("grid = %d×%d, %d cols, %d rows", cellW, cellH, cols, rows)
	}
}

func TestSpriteSizeAndWindowOrigin(t *testing.T) {
	width, height := spriteSize(0.55)
	if math.Abs(width-79.2) > 0.001 || math.Abs(height-85.8) > 0.001 {
		t.Fatalf("sprite = %v×%v", width, height)
	}
	frameW, frameH := frameSize(0.55, 0)
	originX, originY := windowOrigin(200, 200, frameW, frameH)
	if originX != 200-frameW || originY != 200-frameH {
		t.Fatalf("origin = %d,%d for %d×%d", originX, originY, frameW, frameH)
	}
	wide, tall := frameSize(0.55, controlsExtra)
	if wide != panelWidth || tall <= frameH {
		t.Fatalf("panel frame = %d×%d", wide, tall)
	}
}

func TestFrameColumnWrapsWithThePagePet(t *testing.T) {
	if frameColumn("idle", 279) != 0 || frameColumn("idle", 280) != 1 || frameColumn("idle", 1100) != 0 {
		t.Fatal("idle frames drifted")
	}
	if frameColumn("running", 820) != 0 {
		t.Fatal("running frame did not wrap")
	}
}

func TestBubbleLeavesThePetWhereItIs(t *testing.T) {
	petW, petH := frameSize(0.55, 0)
	const anchorX, anchorY = 1000, 800
	petX, petY := windowOrigin(anchorX, anchorY, petW, petH)
	popX, popY := popOrigin(petX, petY, petW, petH, panelWidth, speechExtra)
	if petX != anchorX-petW || petY != anchorY-petH {
		t.Fatalf("pet origin = %d,%d", petX, petY)
	}
	if againX, againY := windowOrigin(anchorX, anchorY, petW, petH); againX != petX || againY != petY {
		t.Fatalf("anchor changed to %d,%d", againX, againY)
	}
	if popX+panelWidth != petX+petW || popY+speechExtra+popGap != petY {
		t.Fatalf("pop = %d,%d pet = %d,%d %dx%d", popX, popY, petX, petY, petW, petH)
	}
	if popY+speechExtra > petY {
		t.Fatal("bubble overlaps the pet")
	}
}

func TestClampKeepsACornerAndAnEdge(t *testing.T) {
	x, y := defaultOrigin(rect{0, 0, 1920, 1080}, 100, 120)
	if x != 1796 || y != 936 {
		t.Fatalf("corner = %d,%d", x, y)
	}
	x, y = clampToAreas(900, 10, 100, 80, 48, []rect{{0, 0, 800, 600}})
	if x != 752 || y != 10 {
		t.Fatalf("right edge = %d,%d", x, y)
	}
	x, y = clampToAreas(100, 100, 80, 80, 48, []rect{{0, 0, 800, 600}})
	if x != 100 || y != 100 {
		t.Fatalf("inside moved to %d,%d", x, y)
	}
	x, y = clampToAreas(3, 4, 80, 80, 48, nil)
	if x != 3 || y != 4 {
		t.Fatalf("empty areas changed the point to %d,%d", x, y)
	}
}

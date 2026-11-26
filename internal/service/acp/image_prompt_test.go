package acp

import "testing"

func TestPromptBlocksPreserveInput(t *testing.T) {
	const message = "  展示二维码\n\n"
	images := []string{"data:image/png;base64,iVBORw=="}
	blocks := promptBlocks(message, images)
	if len(blocks) != 2 || blocks[0].Type != "text" || blocks[0].Text != message ||
		blocks[1].Type != "image" || blocks[1].MIMEType != "image/png" || blocks[1].Data != "iVBORw==" {
		t.Fatalf("prompt blocks = %+v", blocks)
	}
	if blocks := promptBlocks("", images); len(blocks) != 1 || blocks[0].Type != "image" {
		t.Fatalf("image-only prompt blocks = %+v", blocks)
	}
	if blocks := promptBlocks("", nil); len(blocks) != 0 {
		t.Fatalf("empty prompt blocks = %+v", blocks)
	}
}

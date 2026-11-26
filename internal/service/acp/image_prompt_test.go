package acp

import (
	"strings"
	"testing"

	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func TestPromptBlocksIncludeReplyImageConventionOnce(t *testing.T) {
	message := "展示二维码"
	blocks := promptBlocks(message, []string{"data:image/png;base64,iVBORw=="}, true)
	if len(blocks) != 3 || blocks[0].Text != message || blocks[1].Type != "image" || blocks[1].MIMEType != "image/png" ||
		!strings.Contains(blocks[2].Text, agentpkg.ReplyImageInstruction) {
		t.Fatalf("first prompt blocks = %+v", blocks)
	}

	blocks = promptBlocks(message, []string{"data:image/png;base64,iVBORw=="}, false)
	if len(blocks) != 2 || blocks[0].Text != message || blocks[1].Type != "image" {
		t.Fatalf("later prompt blocks = %+v", blocks)
	}
	for _, block := range blocks {
		if strings.Contains(block.Text, agentpkg.ReplyImageInstruction) {
			t.Fatalf("later prompt repeated display convention: %+v", blocks)
		}
	}

	if blocks := promptBlocks("", nil, true); len(blocks) != 2 || blocks[0].Text != reqPlaceholder {
		t.Fatalf("empty first input changed: %+v", blocks)
	}
	if blocks := promptBlocks("", nil, false); len(blocks) != 1 || blocks[0].Text != reqPlaceholder {
		t.Fatalf("empty later input changed: %+v", blocks)
	}
}

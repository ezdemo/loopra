package acp

import (
	"strings"
	"testing"

	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func TestPromptBlocksIncludeReplyImageConvention(t *testing.T) {
	message := "展示二维码"
	blocks := promptBlocks(message, []string{"data:image/png;base64,iVBORw=="})
	if len(blocks) != 3 || blocks[0].Text != message || blocks[1].Type != "image" || blocks[1].MIMEType != "image/png" {
		t.Fatalf("user content changed: %+v", blocks)
	}
	if !strings.Contains(blocks[2].Text, agentpkg.ReplyImageInstruction) {
		t.Fatalf("missing display convention: %+v", blocks)
	}
	if blocks := promptBlocks("", nil); len(blocks) != 2 || blocks[0].Text != reqPlaceholder {
		t.Fatalf("empty input changed: %+v", blocks)
	}
}

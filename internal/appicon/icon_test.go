package appicon

import (
	"bytes"
	"testing"
)

func TestPNGEmbedded(t *testing.T) {
	if !bytes.HasPrefix(PNG, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("embedded icon is not a PNG (%d bytes)", len(PNG))
	}
}

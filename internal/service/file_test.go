package service

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileImageValidation(t *testing.T) {
	root := t.TempDir()
	service := NewFileService()
	for _, item := range []struct {
		name string
		data []byte
	}{
		{"text.png", []byte("not an image")},
		{"unsafe.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)},
	} {
		if err := os.WriteFile(filepath.Join(root, item.name), item.data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	file, err := os.Create(filepath.Join(root, "large.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate((5 << 20) + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{".", "missing.png", "text.png", "unsafe.svg", "large.png", "../escape.png"} {
		t.Run(path, func(t *testing.T) {
			if _, _, err := service.Image(root, path); err == nil {
				t.Fatalf("accepted %q", path)
			}
		})
	}
}

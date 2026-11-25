package microacp

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func gzipBytes(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestStage(t *testing.T) {
	root := t.TempDir()
	want := []byte("micro-acp test binary")
	license := []byte("MIT License\n")
	executable, cleanup, err := stage(root, gzipBytes(t, want), license)
	if err != nil {
		t.Fatal(err)
	}
	name := "micro-acp"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if filepath.Base(executable) != name {
		t.Fatalf("executable %q, want basename %q", executable, name)
	}
	if got, err := os.ReadFile(executable); err != nil || !bytes.Equal(got, want) {
		t.Fatalf("executable contents = %q, %v; want %q", got, err, want)
	}
	if got, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "LICENSE")); err != nil || !bytes.Equal(got, license) {
		t.Fatalf("LICENSE contents = %q, %v; want %q", got, err, license)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cleanup left %d entries under %s", len(entries), root)
	}
}

func TestStageRejectsCorruptPayload(t *testing.T) {
	root := t.TempDir()
	data := gzipBytes(t, []byte("payload"))
	data[len(data)-8] ^= 1 // CRC32 footer
	_, _, err := stage(root, data, nil)
	if err == nil {
		t.Fatal("expected corrupt payload to fail")
	}
	entries, readErr := os.ReadDir(root)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("failed stage left %d entries under %s", len(entries), root)
	}
}

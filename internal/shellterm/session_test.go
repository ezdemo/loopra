package shellterm

import (
	"testing"
	"time"
)

func TestOpenWritesAndCloses(t *testing.T) {
	dir := t.TempDir()
	session, err := Open("term-test", dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.Close)
	deadline := time.Now().Add(4 * time.Second)
	var frame []byte
	mirror, err := session.Mirror()
	if err != nil {
		t.Fatal(err)
	}
	defer mirror.Close()
	for time.Now().Before(deadline) && len(frame) == 0 {
		frame, _ = mirror.Frame()
		if len(frame) == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if len(frame) == 0 {
		t.Fatal("shell produced no screen")
	}
	if err := session.Write([]byte("echo loopra-shell\r")); err != nil {
		t.Fatal(err)
	}
	info := session.Info()
	if info.ID != "term-test" || info.Exited {
		t.Fatalf("info = %+v", info)
	}
}

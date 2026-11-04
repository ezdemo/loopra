package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	lines := make([]string, 10)
	for i := range lines {
		lines[i] = "line-" + string(rune('a'+i))
	}
	if err := os.WriteFile(filepath.Join(root, "multi.txt"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "crlf.txt"), []byte("one\r\ntwo\r\nthree\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestReadSkipsToOffsetAndWindow(t *testing.T) {
	root := readFixture(t)
	out, err := runRead(context.Background(), root, readInput{Path: "multi.txt", Offset: 3, MaxLine: 2})
	if err != nil {
		t.Fatal(err)
	}
	if out["result"] != "3: line-c\n4: line-d\n" {
		t.Fatalf("result = %q", out["result"])
	}
	if out["start_line"] != 3 || out["end_line"] != 4 || out["total_lines"] != 10 || out["truncated"] != true {
		t.Fatalf("metadata = %v", out)
	}
	if out["omitted_before"] != 2 || out["omitted_after"] != 6 {
		t.Fatalf("omissions = %v", out)
	}
}

func TestReadDefaultsAndNegativeOffset(t *testing.T) {
	root := readFixture(t)
	all, err := runRead(context.Background(), root, readInput{Path: "multi.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if all["start_line"] != 1 || all["end_line"] != 10 || all["truncated"] != false {
		t.Fatalf("full read = %v", all)
	}
	if !strings.HasPrefix(all["result"].(string), "1: line-a\n2: line-b\n") {
		t.Fatalf("full read text = %q", all["result"])
	}
	tail, err := runRead(context.Background(), root, readInput{Path: "multi.txt", Offset: -2})
	if err != nil {
		t.Fatal(err)
	}
	if tail["start_line"] != 9 || tail["result"] != "9: line-i\n10: line-j\n" {
		t.Fatalf("tail read = %v", tail)
	}
	// offset 超出文件长度时返回空窗口而不是报错。
	past, err := runRead(context.Background(), root, readInput{Path: "multi.txt", Offset: 99})
	if err != nil {
		t.Fatal(err)
	}
	if past["result"] != "" || past["end_line"] != 10 {
		t.Fatalf("past-end read = %v", past)
	}
}

func TestReadCRLFAndErrors(t *testing.T) {
	root := readFixture(t)
	out, err := runRead(context.Background(), root, readInput{Path: "crlf.txt", Offset: 2, MaxLine: 1})
	if err != nil {
		t.Fatal(err)
	}
	if out["result"] != "2: two\n" || out["total_lines"] != 3 {
		t.Fatalf("crlf read = %v", out)
	}
	if _, err := runRead(context.Background(), root, readInput{Path: "multi.txt", MaxLine: -1}); err == nil {
		t.Fatal("negative max_line accepted")
	}
	if _, err := runRead(context.Background(), root, readInput{Path: "."}); err == nil {
		t.Fatal("directory accepted")
	}
	// 只读工具永远不受工作区限制。
	outside := t.TempDir()
	target := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(target, []byte("outside\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err = runRead(context.Background(), root, readInput{Path: target})
	if err != nil {
		t.Fatal(err)
	}
	if out["result"] != "1: outside\n" {
		t.Fatalf("outside read = %v", out)
	}
	// 即使开启了写入限制，read 仍然可以读项目外的文件。
	if _, err := runRead(WithWorkspaceScope(context.Background(), true), root, readInput{Path: target}); err != nil {
		t.Fatalf("read was restricted: %v", err)
	}
}

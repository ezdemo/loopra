package controller

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilesImageSearchDelete(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	_ = key
	os.MkdirAll(filepath.Join(ws, "img"), 0o755)
	image := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}
	os.WriteFile(filepath.Join(ws, "img", "dot.png"), image, 0o644)
	os.WriteFile(filepath.Join(ws, "notes.txt"), []byte("hi"), 0o644)

	req, _ := http.NewRequest("GET", ts.URL+"/api/files/image?path=img/dot.png", nil)
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || string(raw) != string(image) {
		t.Fatalf("image = %d %s", resp.StatusCode, raw)
	}
	// 拒绝路径逃逸
	code, _ := call(t, ts, http.MethodGet, "/api/files/image?path=../x.png", key, nil)
	if code != http.StatusBadRequest {
		t.Fatal("escape accepted")
	}
	// 按名称搜索
	_, env := call(t, ts, http.MethodGet, "/api/files/search?query=notes", key, nil)
	hits := env["data"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["path"] != "notes.txt" {
		t.Fatalf("search = %v", hits)
	}
	// Java 端对空查询返回数量有上限的文件列表。
	code, _ = call(t, ts, http.MethodGet, "/api/files/search", key, nil)
	if code != http.StatusOK {
		t.Fatal("empty query rejected")
	}
	// 删除文件
	_, env = call(t, ts, http.MethodDelete, "/api/files/delete", key,
		map[string]string{"path": "notes.txt"})
	if env["data"] != "已删除" {
		t.Fatalf("delete = %v", env)
	}
	if _, err := os.Stat(filepath.Join(ws, "notes.txt")); !os.IsNotExist(err) {
		t.Fatal("file survived delete")
	}
	// 项目根目录受保护
	code, env = call(t, ts, http.MethodDelete, "/api/files/delete", key,
		map[string]string{"path": "."})
	if code != http.StatusBadRequest || !strings.Contains(env["error"].(string), "根目录") {
		t.Fatalf("root delete = %d %v", code, env)
	}
}

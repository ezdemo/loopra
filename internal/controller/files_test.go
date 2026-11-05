package controller

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
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

func TestReplyImagesFollowSessionEnvironment(t *testing.T) {
	ts, key, _, ws := newGitServer(t)
	mainImage := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 'm'}
	branchImage := append(append([]byte(nil), mainImage[:8]...), 'b')
	name := "二维码 result.png"
	if err := os.WriteFile(filepath.Join(ws, name), mainImage, 0o600); err != nil {
		t.Fatal(err)
	}
	run := gitops.Runner{Dir: ws}
	if _, _, err := run.Git(gitops.TimeoutQuery, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run.Git(gitops.TimeoutQuery, "commit", "-q", "-m", "seed"); err != nil {
		t.Fatal(err)
	}
	code, env := call(t, ts, http.MethodPost, "/api/git/worktree/create", key,
		map[string]string{"workspaceHash": "git0000001", "sessionName": "image session"})
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("worktree create: %d %v", code, env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/git/environment?sessionName=image%20session", key, nil)
	current := env["data"].(map[string]any)["currentPath"].(string)
	if err := os.WriteFile(filepath.Join(current, name), branchImage, 0o600); err != nil {
		t.Fatal(err)
	}
	check := func(method, session, path, wantKey string, status int, want []byte) {
		t.Helper()
		query := url.Values{"path": {path}, "sessionName": {session}, "workspaceHash": {"git0000001"}}
		req, err := http.NewRequest(method, ts.URL+"/api/files/image?"+query.Encode(), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Loopra-Key", wantKey)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != status || want != nil && string(raw) != string(want) {
			t.Fatalf("%s %s %s: %d %q", method, session, path, resp.StatusCode, raw)
		}
		if status == http.StatusOK && (resp.Header.Get("Content-Type") != "image/png" || resp.Header.Get("X-Content-Type-Options") != "nosniff") {
			t.Fatalf("image headers: %v", resp.Header)
		}
	}
	check(http.MethodGet, "", name, key, http.StatusOK, mainImage)
	check(http.MethodGet, "local", name, key, http.StatusOK, mainImage)
	check(http.MethodGet, "image session", name, key, http.StatusOK, branchImage)
	check(http.MethodHead, "image session", name, key, http.StatusOK, []byte{})
	check(http.MethodGet, "image session", "../"+name, key, http.StatusBadRequest, nil)
	check(http.MethodGet, "image session", name, "", http.StatusUnauthorized, nil)
	code, env = call(t, ts, http.MethodPut, "/api/sessions/missing/worktree", key, map[string]any{"worktreeMode": true})
	if code != http.StatusOK || env["success"] != true {
		t.Fatalf("worktree mode: %d %v", code, env)
	}
	check(http.MethodGet, "missing", name, key, http.StatusBadRequest, nil)
	// An explicit absolute path remains readable even when a worktree is absent.
	outside := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(outside, mainImage, 0o600); err != nil {
		t.Fatal(err)
	}
	check(http.MethodGet, "missing", outside, key, http.StatusOK, mainImage)
	if err := os.Remove(filepath.Join(current, name)); err != nil {
		t.Fatal(err)
	}
	check(http.MethodGet, "image session", name, key, http.StatusBadRequest, nil)
}

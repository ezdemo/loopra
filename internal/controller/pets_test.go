package controller

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func petsTestServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	home := t.TempDir()
	ws := filepath.Join(home, "defaultWorkSpace")
	os.MkdirAll(ws, 0o755)
	pets := filepath.Join(home, "pets", "cat")
	os.MkdirAll(pets, 0o755)
	os.WriteFile(filepath.Join(pets, "pet.json"), []byte(`{"name":"小猫"}`), 0o644)
	os.WriteFile(filepath.Join(pets, "spritesheet.webp"), []byte("WEBPDATA"), 0o644)
	cfg := config.Default()
	cfg.WorkspaceDir = ws
	a, err := agentpkg.New(home, "pet0000001", &cfg, agentpkg.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, key, _ := New(a, Options{Home: home, PetsDir: filepath.Join(home, "pets")})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { srv.Close(); ts.Close() })
	return ts, key, home
}

func TestPetsListDetailActive(t *testing.T) {
	ts, key, _ := petsTestServer(t)
	_, env := call(t, ts, http.MethodGet, "/api/pets", key, nil)
	list := env["data"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["name"] != "cat" {
		t.Fatalf("list = %v", list)
	}
	if list[0].(map[string]any)["displayName"] != "小猫" {
		t.Fatalf("meta = %v", list[0])
	}
	// 详情
	_, env = call(t, ts, http.MethodGet, "/api/pets/cat", key, nil)
	if env["data"].(map[string]any)["dirName"] != "cat" {
		t.Fatalf("detail = %v", env["data"])
	}
	// 未知宠物
	code, missing := call(t, ts, http.MethodGet, "/api/pets/dog", key, nil)
	if code != http.StatusOK || missing["success"] != false {
		t.Fatal("unknown pet accepted")
	}
	// 读取/设置当前宠物
	_, env = call(t, ts, http.MethodGet, "/api/pets/active", key, nil)
	if env["data"].(map[string]any)["active"] != false {
		t.Fatalf("active = %v", env["data"])
	}
	_, env = call(t, ts, http.MethodPut, "/api/pets/active", key, map[string]string{"name": "cat"})
	if env["data"] != "已切换到宠物: cat" {
		t.Fatalf("set active = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/pets/active", key, nil)
	if env["data"].(map[string]any)["name"] != "cat" {
		t.Fatalf("active readback = %v", env["data"])
	}
	// 设置未知宠物被拒绝
	code, missing = call(t, ts, http.MethodPut, "/api/pets/active", key, map[string]string{"name": "ghost"})
	if code != http.StatusOK || missing["success"] != false {
		t.Fatal("unknown active accepted")
	}
}

func TestPetsSpritesheetWithRk(t *testing.T) {
	ts, key, _ := petsTestServer(t)
	// 通过 ?rk= 无需密钥头也能访问精灵图
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/pets/cat/spritesheet?rk="+key, nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("spritesheet status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/webp" {
		t.Fatalf("content-type = %q", ct)
	}
	// 错误的 rk 仍返回 401
	req, _ = http.NewRequest(http.MethodGet, ts.URL+"/api/pets/cat/spritesheet?rk=bad", nil)
	resp, err = ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad rk = %d", resp.StatusCode)
	}
}

func TestPetsDelete(t *testing.T) {
	ts, key, _ := petsTestServer(t)
	_, env := call(t, ts, http.MethodDelete, "/api/pets/cat", key, nil)
	if env["data"] != "宠物已删除: cat" {
		t.Fatalf("delete = %v", env)
	}
	_, env = call(t, ts, http.MethodGet, "/api/pets", key, nil)
	if got := len(env["data"].([]any)); got != 0 {
		t.Fatalf("after delete = %d", got)
	}
}

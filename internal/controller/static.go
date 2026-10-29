package controller

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
)

// staticHandler 从目录提供前端产物（对应 Loopra
// classpath 中的 /static），并支持 SPA 历史回退：未知的
// 非 API 路径返回 index.html，使客户端路由在刷新后仍可用。
// 磁盘目录没有 index.html 时改用内嵌页面。两者都没有时保持 404。
func (s *Controller) staticHandler() http.Handler {
	if frontendIndex(s.staticDir) || s.staticFS == nil {
		return s.diskStaticHandler()
	}
	return embeddedStaticHandler(s.staticFS)
}

func frontendIndex(dir string) bool {
	if dir == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && !info.IsDir()
}

func (s *Controller) diskStaticHandler() http.Handler {
	root := s.staticDir
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api") || r.URL.Path == "/api" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeFail(w, http.StatusNotFound, "未找到路径")
			return
		}
		rel := strings.TrimPrefix(r.URL.Path, "/")
		if rel == "" {
			rel = "index.html"
		}
		candidate := filepath.Join(root, filepath.FromSlash(rel))
		if root == "" || !fsutil.WithinPath(root, candidate) {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			http.ServeFile(w, r, candidate)
			return
		}
		// SPA 回退：任何不带扩展名的深层链接都映射到 index
		if !strings.Contains(rel, ".") {
			if _, err := os.Stat(filepath.Join(root, "index.html")); err == nil {
				http.ServeFile(w, r, filepath.Join(root, "index.html"))
				return
			}
		}
		http.NotFound(w, r)
	})
}

func embeddedStaticHandler(files fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api") || r.URL.Path == "/api" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeFail(w, http.StatusNotFound, "未找到路径")
			return
		}
		rel := path.Clean("/" + r.URL.Path)
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" || rel == "." {
			rel = "index.html"
		}
		if rel == ".." || strings.HasPrefix(rel, "../") || path.IsAbs(rel) {
			http.NotFound(w, r)
			return
		}
		if serveEmbedded(w, r, files, rel) {
			return
		}
		if !strings.Contains(path.Base(rel), ".") && serveEmbedded(w, r, files, "index.html") {
			return
		}
		http.NotFound(w, r)
	})
}

func serveEmbedded(w http.ResponseWriter, r *http.Request, files fs.FS, name string) bool {
	file, err := files.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	seeker, ok := file.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(file)
		if err != nil {
			http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
			return true
		}
		seeker = bytes.NewReader(data)
	}
	http.ServeContent(w, r, name, info.ModTime(), seeker)
	return true
}

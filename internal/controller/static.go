package controller

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

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
	return s.embeddedStaticHandler()
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
			if rel == "index.html" {
				s.serveIndexFile(w, r, candidate, info.ModTime())
				return
			}
			http.ServeFile(w, r, candidate)
			return
		}
		// SPA 回退：任何不带扩展名的深层链接都映射到 index
		if !strings.Contains(rel, ".") {
			indexPath := filepath.Join(root, "index.html")
			if info, err := os.Stat(indexPath); err == nil {
				s.serveIndexFile(w, r, indexPath, info.ModTime())
				return
			}
		}
		http.NotFound(w, r)
	})
}

func (s *Controller) embeddedStaticHandler() http.Handler {
	files := s.staticFS
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
		if s.serveEmbedded(w, r, files, rel) {
			return
		}
		if !strings.Contains(path.Base(rel), ".") && s.serveEmbedded(w, r, files, "index.html") {
			return
		}
		http.NotFound(w, r)
	})
}

func (s *Controller) serveIndexFile(w http.ResponseWriter, r *http.Request, name string, mod time.Time) {
	data, err := os.ReadFile(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, "index.html", mod, bytes.NewReader(stampIndexTheme(data, SavedUITheme(s.home))))
}

func (s *Controller) serveEmbedded(w http.ResponseWriter, r *http.Request, files fs.FS, name string) bool {
	file, err := files.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	if name == "index.html" {
		data, err := io.ReadAll(file)
		if err != nil {
			http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
			return true
		}
		http.ServeContent(w, r, name, info.ModTime(), bytes.NewReader(stampIndexTheme(data, SavedUITheme(s.home))))
		return true
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

// stampIndexTheme 让页面在脚本运行前就带上已保存的外观。新页面只填
// window.__LOOPRA_THEME__；已发布的页面没有这段脚本时，补进 <head>。
func stampIndexTheme(html []byte, theme string) []byte {
	switch theme {
	case "dark", "light", "system":
	default:
		theme = ""
	}
	marker := []byte(`window.__LOOPRA_THEME__=""`)
	if bytes.Contains(html, marker) {
		return bytes.Replace(html, marker, []byte(fmt.Sprintf(`window.__LOOPRA_THEME__=%q`, theme)), 1)
	}
	if bytes.Contains(html, []byte("loopra:preferences")) {
		return html
	}
	script := []byte(fmt.Sprintf(`<script>(function(){var theme=%q;var stored="";try{var saved=JSON.parse(localStorage.getItem("loopra:preferences")||"null");if(saved&&typeof saved.theme==="string")stored=saved.theme;}catch(e){}if(stored==="深色"||stored==="月之暗面"||stored==="dark")theme="dark";else if(stored==="浅色"||stored==="月之亮面"||stored==="light")theme="light";else if(stored==="跟随系统"||stored==="system")theme="system";var dark=theme==="dark"||(theme==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var root=document.documentElement;root.classList.add("workspace-theme");root.classList.toggle("dark",dark);root.style.colorScheme=dark?"dark":"light";root.style.backgroundColor=dark?"#191919":"#ffffff";})();</script>`, theme))
	lower := bytes.ToLower(html)
	if start := bytes.Index(lower, []byte("<head")); start >= 0 {
		if end := bytes.IndexByte(html[start:], '>'); end >= 0 {
			at := start + end + 1
			out := make([]byte, 0, len(html)+len(script))
			out = append(out, html[:at]...)
			out = append(out, script...)
			out = append(out, html[at:]...)
			return out
		}
	}
	return html
}

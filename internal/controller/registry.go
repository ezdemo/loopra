package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/repository"
)

// registryController 实现插件相关端点。Java
// 运行时通过 cutin 插件内核加载 .jar 插件与扩展包；
// Go 运行时没有 JVM，因此这些视图返回真实的空列表，
// 安装操作会说明该边界。
func (s *Controller) pluginsController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/plugins/external") {
		s.externalPluginsController(w, r)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/toggle") {
		writeFail(w, http.StatusBadRequest, "插件不存在")
		return
	}
	writeOK(w, http.StatusOK, []any{})
}

func (s *Controller) externalPluginsController(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.home, "plugins", "installed.json")
	if r.Method == http.MethodGet {
		var manifest struct {
			Plugins []map[string]any `json:"plugins"`
		}
		raw, _ := os.ReadFile(path)
		_ = json.Unmarshal(raw, &manifest)
		if manifest.Plugins == nil {
			manifest.Plugins = []map[string]any{}
		}
		writeOK(w, http.StatusOK, manifest.Plugins)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/install") {
		var body struct {
			Source string `json:"source"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Source) == "" {
			writeFail(w, http.StatusBadRequest, "source 不能为空（仅支持以 .jar 结尾的 http(s) 直链）")
			return
		}
		writeFail(w, http.StatusBadRequest, "加载 Java 插件需要配置 LOOPRA_JAVA_BACKEND_URL")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/plugins/external/"), "/")
	if len(parts) != 2 {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	s.state.files.Lock()
	defer s.state.files.Unlock()
	var manifest struct {
		Plugins []map[string]any `json:"plugins"`
	}
	raw, _ := os.ReadFile(path)
	_ = json.Unmarshal(raw, &manifest)
	for i, entry := range manifest.Plugins {
		if entry["id"] != parts[0] {
			continue
		}
		switch {
		case parts[1] == "remove":
			if file, ok := entry["fileName"].(string); ok && filepath.Base(file) == file && file != "." && file != ".." {
				if err := os.Remove(filepath.Join(s.home, "plugins", file)); err != nil && !os.IsNotExist(err) {
					writeFail(w, http.StatusInternalServerError, err.Error())
					return
				}
			}
			manifest.Plugins = append(manifest.Plugins[:i], manifest.Plugins[i+1:]...)
			if err := repository.WriteJSON(path, manifest); err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeOK(w, http.StatusOK, "插件已卸载: "+parts[0])
		case parts[1] == "toggle":
			var body struct {
				Enabled bool `json:"enabled"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				writeFail(w, http.StatusBadRequest, "请求体不能为空")
				return
			}
			if body.Enabled {
				writeFail(w, http.StatusBadRequest, "加载 Java 插件需要配置 LOOPRA_JAVA_BACKEND_URL")
				return
			}
			entry["enabled"] = false
			if err := repository.WriteJSON(path, manifest); err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeOK(w, http.StatusOK, entry)
		default:
			writeFail(w, http.StatusNotFound, "未找到路径")
		}
		return
	}
	writeFail(w, http.StatusBadRequest, "插件不存在: "+parts[0])
}

func (s *Controller) extpacksController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	switch {
	case strings.HasSuffix(r.URL.Path, "/install"):
		writeFail(w, http.StatusBadRequest, "Go 运行时不支持扩展包安装（无 JVM）")
	case strings.HasSuffix(r.URL.Path, "/toggle"), strings.HasSuffix(r.URL.Path, "/start"),
		strings.HasSuffix(r.URL.Path, "/stop"), strings.HasSuffix(r.URL.Path, "/uninstall"):
		writeFail(w, http.StatusBadRequest, "扩展包不存在")
	default:
		writeOK(w, http.StatusOK, []any{})
	}
}

// skillMarketController 适配受支持的技能市场。
func (s *Controller) skillMarketController(w http.ResponseWriter, r *http.Request) {
	s.marketController(w, r)
}

// openApiController 管理持久化的文档源及其搜索索引。
func (s *Controller) openApiController(w http.ResponseWriter, r *http.Request) {
	s.openapiManageController(w, r)
}

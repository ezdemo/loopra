package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"github.com/ezdemo/looprax/internal/service/plugin"
)

func (s *Controller) openPluginUI(w http.ResponseWriter, r *http.Request, id string) {
	if !s.plugins.Installed(id) {
		writeFail(w, http.StatusNotFound, "插件不存在: "+id)
		return
	}
	if _, err := s.plugins.SettingsFile(id, ""); err != nil {
		writeFail(w, http.StatusNotFound, err.Error())
		return
	}
	token, err := plugin.IssueUITicket(id)
	if err != nil {
		writeFail(w, http.StatusInternalServerError, "设置页暂时打不开")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     plugin.UICookie,
		Value:    token,
		Path:     "/api/plugins/" + id + "/ui",
		MaxAge:   3600,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeOK(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Controller) servePluginConfig(w http.ResponseWriter, path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[1] != "config" {
		return false
	}
	value, err := s.plugins.UIConfig(parts[0])
	if err != nil {
		writeFail(w, http.StatusNotFound, err.Error())
		return true
	}
	writeOK(w, http.StatusOK, value)
	return true
}

func (s *Controller) savePluginConfig(w http.ResponseWriter, r *http.Request, id string) {
	r.Body = http.MaxBytesReader(w, r.Body, plugin.UIConfigLimit)
	var value map[string]any
	if json.NewDecoder(r.Body).Decode(&value) != nil || value == nil {
		writeFail(w, http.StatusBadRequest, "插件配置必须是对象")
		return
	}
	if err := s.plugins.SetUIConfig(id, value); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "不存在") {
			status = http.StatusNotFound
		}
		writeFail(w, status, err.Error())
		return
	}
	saved, err := s.plugins.UIConfig(id)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, saved)
}

func (s *Controller) servePluginUI(w http.ResponseWriter, r *http.Request, path string) bool {
	id, rel, ok := plugin.SplitPluginUI(path)
	if !ok {
		return false
	}
	if !s.plugins.Installed(id) {
		writeFail(w, http.StatusNotFound, "插件不存在: "+id)
		return true
	}
	file, err := s.plugins.SettingsFile(id, rel)
	if err != nil {
		writeFail(w, http.StatusNotFound, err.Error())
		return true
	}
	body, err := os.Open(file)
	if err != nil {
		writeFail(w, http.StatusNotFound, "设置页路径无效")
		return true
	}
	defer body.Close()
	stat, err := body.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		writeFail(w, http.StatusNotFound, "设置页路径无效")
		return true
	}
	ctype, ok := plugin.UIContentType(file)
	if !ok {
		writeFail(w, http.StatusNotFound, "设置页路径无效")
		return true
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if strings.HasPrefix(ctype, "text/html") {
		w.Header().Set("Content-Security-Policy", plugin.UIContentSecurityPolicy(r, id))
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	}
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), body)
	return true
}

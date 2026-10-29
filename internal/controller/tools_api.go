package controller

import (
	"net/http"

	"github.com/ezdemo/looprax/internal/service/tools"
)

func (s *Controller) toolInfoController(w http.ResponseWriter, r *http.Request) {
	s.applyToolConfig()
	for _, entry := range s.registry.List() {
		if entry["name"] == r.PathValue("name") {
			writeOK(w, http.StatusOK, entry)
			return
		}
	}
	writeFail(w, http.StatusBadRequest, "工具不存在: "+r.PathValue("name"))
}

func (s *Controller) toolAutoToggleController(w http.ResponseWriter, r *http.Request) {
	s.applyToolConfig()
	name := r.PathValue("name")
	found := false
	for _, entry := range s.registry.List() {
		found = found || entry["name"] == name
	}
	if !found {
		writeFail(w, http.StatusBadRequest, "工具不存在: "+name)
		return
	}
	cfg := s.configSnapshot()
	names := []string{}
	enabled := true
	for _, n := range cfg.AutoWhitelist {
		n = tools.ResolveName(n)
		if n == name {
			enabled = false
		} else {
			names = append(names, n)
		}
	}
	if enabled {
		names = append(names, name)
	}
	if err := s.saveConfig(map[string]any{"autoWhitelist": names}); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.applyToolConfig()
	action := "已移除自动放行: "
	if enabled {
		action = "已添加自动放行: "
	}
	writeOK(w, http.StatusOK, action+name)
}

func (s *Controller) persistToolSettings() error {
	disabled := []string{}
	overrides := map[string]bool{}
	for _, entry := range s.registry.List() {
		name := entry["name"].(string)
		if entry["enabled"] == false {
			disabled = append(disabled, name)
		}
		if value, ok := entry["readOnlyOverride"].(bool); ok {
			overrides[name] = value
		}
	}
	return s.saveConfig(map[string]any{"disabledTools": disabled, "toolReadOnlyOverrides": overrides})
}

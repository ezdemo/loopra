package controller

import (
	"encoding/json"
	"net/http"
)

// toolsController 实现 GET /api/tools 以及各开关端点。
func (s *Controller) toolsController(w http.ResponseWriter, r *http.Request) {
	s.applyToolConfig()
	writeOK(w, http.StatusOK, s.registry.List())
}

func (s *Controller) toolsToggle(w http.ResponseWriter, r *http.Request) {
	s.applyToolConfig()
	name := r.PathValue("name")
	enabled, err := s.registry.Toggle(name)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	action := "已禁用"
	if err := s.persistToolSettings(); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if enabled {
		action = "已启用"
	}
	writeOK(w, http.StatusOK, action+"工具: "+name)
}

func (s *Controller) toolsReadOnly(w http.ResponseWriter, r *http.Request) {
	s.applyToolConfig()
	name := r.PathValue("name")
	var body struct {
		ReadOnly *bool `json:"readOnly"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := s.registry.SetReadOnly(name, body.ReadOnly); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.persistToolSettings(); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	action := "默认"
	switch {
	case body.ReadOnly == nil:
	case *body.ReadOnly:
		action = "只读"
	default:
		action = "写入"
	}
	writeOK(w, http.StatusOK, "已将工具分类设置为"+action+": "+name)
}

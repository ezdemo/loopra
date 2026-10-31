package controller

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

func (s *Controller) openapiManageController(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/openapi/")
	action := ""
	switch {
	case path == "sources" && r.Method == http.MethodGet:
		action = "sources"
	case path == "search" && r.Method == http.MethodGet:
		action = "search"
	case path == "sources" && r.Method == http.MethodPost:
		action = "save"
	case path == "sources/refresh" && r.Method == http.MethodPut:
		action = "refresh"
	case path == "sources" && r.Method == http.MethodDelete:
		action = "remove"
	}
	if action == "" {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	input := map[string]any{}
	if action == "search" {
		input["keyword"] = r.URL.Query().Get("keyword")
	} else if action != "sources" {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			writeFail(w, http.StatusBadRequest, "请求体必须是对象")
			return
		}
	}
	out, err := s.openapi.Request(r.Context(), action, input)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, out)
}

func (s *Controller) pluginServiceRequest(ctx context.Context, id, action string, input map[string]any) (any, error) {
	if id != "openapi" {
		return nil, errors.New("插件没有此宿主服务")
	}
	return s.openapi.Request(ctx, action, input)
}

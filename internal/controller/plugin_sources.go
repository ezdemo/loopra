package controller

import (
	"encoding/json"
	"net/http"
)

func (s *Controller) pluginSourceController(w http.ResponseWriter, r *http.Request, path string) {
	var data any
	var err error
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		switch path {
		case "sources":
			data, err = s.plugins.Sources()
		case "catalog":
			data, err = s.plugins.Catalog(r.Context(), r.URL.Query().Get("source"))
		default:
			writeFail(w, http.StatusNotFound, "未找到路径")
			return
		}
	} else {
		r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
		var body struct {
			Source string `json:"source"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			writeFail(w, http.StatusBadRequest, "请求格式无效")
			return
		}
		data, err = s.plugins.SetSource(body.Source, path == "sources/remove")
	}
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, data)
}

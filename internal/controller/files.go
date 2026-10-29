package controller

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/service"
)

func (s *Controller) filesDeepController(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/image"):
		s.filesImage(w, r)
	case strings.HasSuffix(r.URL.Path, "/search"):
		s.filesSearch(w, r)
	case strings.HasSuffix(r.URL.Path, "/delete") && r.Method == http.MethodDelete:
		s.filesDelete(w, r)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) filesImage(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeFail(w, http.StatusBadRequest, "path 参数必填")
		return
	}
	data, mime, err := s.files.Image(s.workspaceRoot(), path)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Controller) filesSearch(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	if query == "" {
		query = r.URL.Query().Get("q")
	}
	writeOK(w, http.StatusOK, s.files.Search(s.workspaceRoot(), query))
}

func (s *Controller) filesDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	body.Path = r.URL.Query().Get("path")
	if body.Path == "" && r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	if body.Path == "" {
		writeFail(w, http.StatusBadRequest, "path 必填")
		return
	}
	if err := s.files.Delete(s.workspaceRoot(), body.Path); err != nil {
		switch {
		case errors.Is(err, fsutil.ErrInvalidPath):
			writeFail(w, http.StatusBadRequest, "Invalid path")
		case errors.Is(err, service.ErrWorkspaceRoot):
			writeFail(w, http.StatusBadRequest, err.Error())
		default:
			writeFail(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	writeOK(w, http.StatusOK, "已删除")
}

func (s *Controller) filesTree(w http.ResponseWriter, r *http.Request) {
	entries, err := s.files.Tree(s.workspaceRoot(), r.URL.Query().Get("path"))
	if err != nil {
		if errors.Is(err, fsutil.ErrInvalidPath) {
			writeFail(w, http.StatusBadRequest, "无效的文件路径")
		} else {
			writeFail(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	writeOK(w, http.StatusOK, entries)
}

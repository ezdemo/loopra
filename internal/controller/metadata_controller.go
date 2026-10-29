package controller

import (
	"net/http"
)

// modelMetaRefreshController 实现 POST /api/model-meta/refresh。
func (s *Controller) modelMetaRefreshController(w http.ResponseWriter, r *http.Request) {
	s.refreshModelMetadata(w, r)
}

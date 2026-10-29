package controller

import (
	"net/http"
)

// versionUpdateController 管理后台原生更新器。
func (s *Controller) versionUpdateController(w http.ResponseWriter, r *http.Request) {
	s.updateController(w, r)
}

// versionCheckController 检查 Looprax 发布仓库。
func (s *Controller) versionCheckController(w http.ResponseWriter, r *http.Request) {
	s.checkVersion(w, r)
}

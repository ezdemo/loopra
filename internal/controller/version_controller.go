package controller

import (
	"net/http"
)

// versionController 实现 GET /api/version/。
func (s *Controller) versionController(w http.ResponseWriter, r *http.Request) {
	writeOK(w, http.StatusOK, map[string]any{"version": Version, "buildTime": BuildTime, "name": "looprax"})
}

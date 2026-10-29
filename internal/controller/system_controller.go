package controller

import (
	"net/http"
)

// systemController 实现 /api/system 相关接口。
func (s *Controller) systemController(w http.ResponseWriter, r *http.Request) {
	s.systemAction(w, r)
}

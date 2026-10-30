package controller

import (
	"net/http"
)

func (s *Controller) extpacksController(w http.ResponseWriter, r *http.Request) {
	if s.javaCompatibilityProxy(w, r) {
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		writeOK(w, http.StatusOK, []any{})
		return
	}
	writeFail(w, http.StatusBadRequest, "拓展包已停用。请在插件页用 npm 包或 GitHub 地址安装，由 moejs 执行")
}

// skillMarketController 适配受支持的技能市场。
func (s *Controller) skillMarketController(w http.ResponseWriter, r *http.Request) {
	s.marketController(w, r)
}

// openApiController 管理持久化的文档源及其搜索索引。
func (s *Controller) openApiController(w http.ResponseWriter, r *http.Request) {
	s.openapiManageController(w, r)
}

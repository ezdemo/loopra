package controller

func (s *Controller) registerFilesRoutes(api *apiRouter) {
	readRoute(api, "/files/tree", s.action((*Controller).filesController))
	readRoute(api, "/files/image", s.action((*Controller).filesDeepController))
	readRoute(api, "/files/search", s.action((*Controller).filesDeepController))
	api.DELETE("/files/delete", s.action((*Controller).filesDeepController))
	api.POST("/files/paste", s.action((*Controller).filesController))
	readRoute(api, "/git/", s.action((*Controller).gitController))
	readRoute(api, "/git/*", s.action((*Controller).gitController))
	api.POST("/git/", s.action((*Controller).gitController))
	api.POST("/git/*", s.action((*Controller).gitController))
	api.POST("/snapshots/checkpoint", s.action((*Controller).snapshotCheckpoint))
	api.POST("/snapshots/rollback", s.action((*Controller).snapshotRollback))
	readRoute(api, "/snapshots", s.action((*Controller).snapshotList))
	readRoute(api, "/snapshots/status", s.action((*Controller).snapshotStatus))
	api.DELETE("/snapshots/:msgId", s.action((*Controller).snapshotDelete))

	// Preserve the canonical slash redirects of the existing API.
	s.canonicalRedirect("GET", "/api/git")
	s.canonicalRedirect("HEAD", "/api/git")
	s.canonicalRedirect("POST", "/api/git")
}

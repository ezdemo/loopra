package controller

func (s *Controller) registerSystemRoutes(api *apiRouter) {
	api.POST("/system/open-workspace", s.action((*Controller).systemController))
	readRoute(api, "/system/open-applications", s.action((*Controller).systemController))
	api.POST("/system/pick-directory", s.action((*Controller).systemController))
	readRoute(api, "/system/version", s.action((*Controller).systemController))
	readRoute(api, "/version/", s.action((*Controller).versionController))
	readRoute(api, "/version/*", s.action((*Controller).versionController))
	readRoute(api, "/version/check", s.action((*Controller).versionCheckController))
	readRoute(api, "/version/update", s.action((*Controller).versionUpdateController))
	api.POST("/version/update", s.action((*Controller).versionUpdateController))
	api.POST("/version/update/stop", s.action((*Controller).versionUpdateController))
	readRoute(api, "/pets", s.action((*Controller).petsController))
	readRoute(api, "/pets/", s.action((*Controller).petsController))
	readRoute(api, "/pets/*", s.action((*Controller).petsController))
	api.PUT("/pets/", s.action((*Controller).petsController))
	api.PUT("/pets/*", s.action((*Controller).petsController))
	api.DELETE("/pets/", s.action((*Controller).petsController))
	api.DELETE("/pets/*", s.action((*Controller).petsController))

	// Preserve the canonical slash redirects of the existing API.
	s.canonicalRedirect("DELETE", "/api/pets")
	s.canonicalRedirect("GET", "/api/version")
	s.canonicalRedirect("HEAD", "/api/version")
	s.canonicalRedirect("PUT", "/api/pets")
}

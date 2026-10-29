package controller

func (s *Controller) registerTasksRoutes(api *apiRouter) {
	readRoute(api, "/requirements", s.action((*Controller).requirementsController))
	api.POST("/requirements", s.action((*Controller).requirementsController))
	readRoute(api, "/requirements/:id", s.action((*Controller).requirementsController))
	api.PUT("/requirements/:id", s.action((*Controller).requirementsController))
	api.DELETE("/requirements/:id", s.action((*Controller).requirementsController))
	api.POST("/requirements/:id/", s.action((*Controller).requirementsController))
	api.POST("/requirements/:id/*", s.action((*Controller).requirementsController))
	readRoute(api, "/requirements/:id/", s.action((*Controller).requirementsController))
	readRoute(api, "/requirements/:id/*", s.action((*Controller).requirementsController))
	readRoute(api, "/schedules", s.action((*Controller).schedulesController))
	api.POST("/schedules", s.action((*Controller).schedulesController))
	readRoute(api, "/schedules/:id", s.action((*Controller).schedulesController))
	api.PUT("/schedules/:id", s.action((*Controller).schedulesController))
	api.DELETE("/schedules/:id", s.action((*Controller).schedulesController))
	api.POST("/schedules/:id/toggle", s.action((*Controller).schedulesController))
	api.POST("/schedules/:id/run", s.action((*Controller).schedulesController))

	// Preserve the canonical slash redirects of the existing API.
	s.canonicalRedirect("POST", "/api/requirements/:id")
}

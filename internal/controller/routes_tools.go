package controller

func (s *Controller) registerToolsRoutes(api *apiRouter) {
	if s.registry != nil {
		readRoute(api, "/tools", s.action((*Controller).toolsController))
		api.POST("/tools/:name/toggle", s.action((*Controller).toolsToggle))
		api.POST("/tools/:name/read-only", s.action((*Controller).toolsReadOnly))
		readRoute(api, "/tools/:name", s.action((*Controller).toolInfoController))
		api.POST("/tools/:name/auto-toggle", s.action((*Controller).toolAutoToggleController))
	}
}

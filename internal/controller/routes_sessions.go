package controller

func (s *Controller) registerSessionsRoutes(api *apiRouter) {
	if s.agent != nil {
		readRoute(api, "/sessions", s.action((*Controller).sessionsController))
		api.POST("/sessions/new", s.action((*Controller).sessionsNew))
		api.POST("/sessions/:name", s.action((*Controller).sessionSwitchController))
		api.DELETE("/sessions", s.action((*Controller).sessionsClearController))
		api.DELETE("/sessions/:name", s.action((*Controller).sessionsDelete))
		api.PUT("/sessions/order", s.action((*Controller).sessionsDeepController))
		readRoute(api, "/sessions/current", s.action((*Controller).sessionsDeepController))
		readRoute(api, "/sessions/stats", s.action((*Controller).sessionsDeepController))
		api.POST("/sessions/evict-all", s.action((*Controller).sessionsDeepController))
		api.DELETE("/sessions/cleanup", s.action((*Controller).sessionsDeepController))
		readRoute(api, "/sessions/:name/settings", s.action((*Controller).sessionsDeepController))
		api.PUT("/sessions/:name/settings", s.action((*Controller).sessionsDeepController))
		readRoute(api, "/sessions/:name/worktree", s.action((*Controller).sessionsDeepController))
		api.PUT("/sessions/:name/worktree", s.action((*Controller).sessionsDeepController))
		api.PUT("/sessions/:name/title", s.action((*Controller).sessionsDeepController))
		api.POST("/sessions/:name/branch", s.action((*Controller).sessionsDeepController))
		api.POST("/sessions/:name/fork", s.action((*Controller).sessionsDeepController))
		readRoute(api, "/sessions/:name/checklist", s.action((*Controller).sessionsDeepController))
		readRoute(api, "/sessions/:name/goal", s.action((*Controller).sessionsDeepController))
		api.POST("/sessions/file-changes/revert", s.action((*Controller).sessionsDeepController))
	}
}

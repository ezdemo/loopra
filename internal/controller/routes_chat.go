package controller

func (s *Controller) registerChatRoutes(api *apiRouter) {
	api.POST("/chat/stream", s.action((*Controller).chatStreamHandler))
	api.POST("/chat/abort", s.action((*Controller).abortHandler))
	readRoute(api, "/chat/permissions", s.action((*Controller).chatPermissionsController))
	api.POST("/chat/permission", s.action((*Controller).chatPermissionsController))
	readRoute(api, "/chat/elicitations", s.action((*Controller).chatElicitationsController))
	api.POST("/chat/elicitation", s.action((*Controller).chatElicitationsController))
	api.POST("/chat/sub-hitl/:subId", s.action((*Controller).subHitlController))
}

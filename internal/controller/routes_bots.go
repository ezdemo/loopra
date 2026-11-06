package controller

func (s *Controller) registerBotRoutes(api *apiRouter) {
	readRoute(api, "/bots", s.action((*Controller).botsController))
	api.PUT("/bots/:id", s.action((*Controller).botsController))
	api.DELETE("/bots/:id", s.action((*Controller).botsController))
	api.POST("/bots/registrations", s.action((*Controller).botRegistrationController))
	readRoute(api, "/bots/registrations/:id", s.action((*Controller).botRegistrationController))
	api.DELETE("/bots/registrations/:id", s.action((*Controller).botRegistrationController))
}

package controller

func (s *Controller) registerConfigRoutes(api *apiRouter) {
	readRoute(api, "/config", s.action((*Controller).configController))
	api.PUT("/config", s.action((*Controller).configController))
	readRoute(api, "/models", s.action((*Controller).modelsController))
	readRoute(api, "/remote-models", s.action((*Controller).remoteModelsController))
	api.POST("/remote-models", s.action((*Controller).remoteModelsController))
	readRoute(api, "/workspace", s.action((*Controller).workspaceController))
	api.POST("/workspace", s.action((*Controller).workspaceController))
	readRoute(api, "/workspaces", s.action((*Controller).workspaceController))
	readRoute(api, "/workspaces/order", s.action((*Controller).workspaceController))
	api.PUT("/workspaces/order", s.action((*Controller).workspaceController))
	api.PUT("/workspaces/:hash/name", s.action((*Controller).workspaceController))
	api.DELETE("/workspaces/:hash", s.action((*Controller).workspaceController))
	readRoute(api, "/loopra-md", s.action((*Controller).loopraMDController))
	api.PUT("/loopra-md", s.action((*Controller).loopraMDController))
	readRoute(api, "/usage", s.action((*Controller).usageController))
	readRoute(api, "/usage/dashboard", s.action((*Controller).dashboardController))
	api.POST("/model-meta/refresh", s.action((*Controller).modelMetaRefreshController))
	readRoute(api, "/prompt-presets", s.action((*Controller).promptPresetsController))
	api.PUT("/prompt-presets", s.action((*Controller).promptPresetsController))
}

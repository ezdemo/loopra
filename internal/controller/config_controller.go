package controller

import (
	"encoding/json"
	"net/http"
)

// configController 读取脱敏后的配置视图，并持久化合并后的更新。
func (s *Controller) configController(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		c := s.configSnapshot()
		raw, _ := json.Marshal(c)
		var view map[string]any
		_ = json.Unmarshal(raw, &view)
		view["apiKey"], view["workspace"], view["modelChannelsConfigured"] = maskKey(c.APIKey), s.workspaceRoot(), false
		if c.APIKey == "" {
			view["apiKey"] = "****"
		}
		for _, channel := range view["modelChannels"].([]any) {
			ch := channel.(map[string]any)
			key, _ := ch["apiKey"].(string)
			ch["apiKey"] = maskKey(key)
			if key != "" {
				view["modelChannelsConfigured"] = true
			}
			if models, ok := ch["models"].([]any); ok {
				for _, item := range models {
					if model, ok := item.(map[string]any); ok {
						if model["displayName"] == nil {
							model["displayName"] = ""
						}
						if model["price"] == nil {
							model["price"] = map[string]any{}
						}
					}
				}
			}
		}
		names := []string{}
		for _, channel := range c.ModelChannels {
			for _, model := range channel.Models {
				if !containsString(names, model.Name) {
					names = append(names, model.Name)
				}
			}
		}
		if len(names) == 0 {
			names = append(names, c.AvailableModels...)
		}
		view["availableModels"] = names
		if view["price"] == nil {
			view["price"] = map[string]any{}
		}
		dto := map[string]any{}
		for _, field := range []string{"baseUrl", "model", "availableModels", "workspace", "editMode", "reasoningEffort", "lang", "hitl", "disabledTools", "blockedPaths", "apiKey", "price", "activePet", "fastMode", "modelChannels", "modelChannelsConfigured", "modelChannelId", "validationModel", "validationModelChannelId", "imageUnderstandingModel", "imageUnderstandingModelChannelId", "toolModel", "toolModelChannelId", "proxy"} {
			if value, exists := view[field]; exists {
				dto[field] = value
			}
		}
		for _, field := range []string{"disabledTools", "blockedPaths"} {
			if dto[field] == nil {
				dto[field] = []string{}
			}
		}
		writeOK(w, http.StatusOK, dto)
	case http.MethodPut:
		var patch map[string]any
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			writeFail(w, http.StatusBadRequest, "配置格式不正确")
			return
		}
		if patch == nil {
			writeFail(w, http.StatusBadRequest, "配置格式不正确")
			return
		}
		s.restoreMaskedKeys(patch)
		if err := s.saveConfig(patch); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		message := "配置已更新"
		for _, key := range []string{"baseUrl", "apiKey", "modelChannels", "modelChannelId", "validationModel", "validationModelChannelId", "imageUnderstandingModel", "imageUnderstandingModelChannelId", "proxy", "proxyAddress"} {
			if _, ok := patch[key]; ok {
				message = "模型渠道已更新，Agent 已重新初始化"
			}
		}
		if _, ok := patch["proxy"]; ok {
			message = "代理已更新，Agent 已重新初始化"
		}
		writeOK(w, http.StatusOK, message)
	}
}

func maskKey(key string) string {
	if len(key) <= 8 {
		if key == "" {
			return ""
		}
		return "****"
	}
	return key[:4] + "****" + key[len(key)-4:]
}

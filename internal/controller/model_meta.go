package controller

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
)

type modelMetadataCache struct {
	mu     sync.Mutex
	stamp  time.Time
	models map[string]map[string]any
}

func (s *Controller) modelMetadata(name string) map[string]any {
	cache := s.state.metadata
	cache.mu.Lock()
	defer cache.mu.Unlock()
	path := filepath.Join(s.home, "model_meta.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	if cache.models == nil || !info.ModTime().Equal(cache.stamp) {
		var providers map[string]struct {
			Models map[string]map[string]any `json:"models"`
		}
		data, err := os.ReadFile(path)
		if err != nil || json.Unmarshal(data, &providers) != nil {
			return nil
		}
		models := map[string]map[string]any{}
		for provider, data := range providers {
			if provider != "openrouter" {
				continue
			}
			for id, model := range data.Models {
				models[provider+"/"+id] = model
				if models[id] == nil {
					models[id] = model
				}
			}
		}
		cache.models, cache.stamp = models, info.ModTime()
	}
	if model := cache.models[name]; model != nil {
		return model
	}
	if index := strings.LastIndex(name, "["); index > 0 && strings.HasSuffix(name, "]") {
		name = name[:index]
	}
	if model := cache.models[name]; model != nil {
		return model
	}
	if index := strings.LastIndex(name, "/"); index >= 0 {
		return cache.models[name[index+1:]]
	}
	return nil
}

func (s *Controller) metadataPrice(name string) (config.Price, bool) {
	model := s.modelMetadata(name)
	if model == nil {
		return config.Price{}, false
	}
	cost, ok := model["cost"].(map[string]any)
	if !ok {
		return config.Price{}, false
	}
	value := func(key string) float64 {
		number, _ := cost[key].(float64)
		return math.Round((number*7+0.00005)*1000) / 1000
	}
	return config.Price{Input: value("input"), Output: value("output"), Cache: value("cache_read")}, true
}

func (s *Controller) refreshModelMetadata(w http.ResponseWriter, r *http.Request) {
	target := os.Getenv("LOOPRA_MODEL_META_URL")
	if target == "" {
		target = "https://models.dev/api.json"
	}
	raw, err := fetchBytes(r, target, 32<<20)
	if err != nil {
		writeFail(w, http.StatusOK, "刷新模型元数据缓存失败: "+err.Error())
		return
	}
	var providers map[string]any
	if json.Unmarshal(raw, &providers) != nil || len(providers) == 0 {
		writeFail(w, http.StatusOK, "刷新模型元数据缓存失败: 文档格式不正确")
		return
	}
	if err := repository.WriteFile(filepath.Join(s.home, "model_meta.json"), raw); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, http.StatusOK, "模型元数据缓存已成功刷新")
}

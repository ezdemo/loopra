// Package service implements application operations independently of HTTP.
package service

import (
	"encoding/json"
	"sync"

	"github.com/ezdemo/looprax/internal/model/config"
)

// ConfigRepository is the persistence contract required by ConfigService.
type ConfigRepository interface {
	Save(*config.Loopra) error
}

type ConfigService struct {
	mu         sync.RWMutex
	repository ConfigRepository
	current    *config.Loopra
}

func NewConfigService(repository ConfigRepository, initial *config.Loopra) *ConfigService {
	return &ConfigService{repository: repository, current: initial.Clone()}
}

func (s *ConfigService) Snapshot() *config.Loopra {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current.Clone()
}

// Update publishes the new snapshot only after persistence succeeds.
func (s *ConfigService) Update(patch map[string]any) (*config.Loopra, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.current.Clone()
	raw, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	for key, value := range patch {
		if value != nil {
			body[key] = value
		}
	}
	raw, err = json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, err
	}
	if err := s.repository.Save(cfg); err != nil {
		return nil, err
	}
	s.current = cfg
	return cfg.Clone(), nil
}

package repository

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/ezdemo/looprax/internal/model/config"
)

type ConfigRepository struct {
	path string
}

func NewConfigRepository(home string) *ConfigRepository {
	return &ConfigRepository{path: filepath.Join(home, "config.json")}
}

func (r *ConfigRepository) Load() (*config.Loopra, error) {
	cfg := config.Default()
	data, err := os.ReadFile(r.path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		if err := r.Save(&cfg); err != nil {
			return nil, err
		}
		return &cfg, nil
	}
	// Unmarshal over defaults to preserve Java's missing-field behavior.
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (r *ConfigRepository) Save(cfg *config.Loopra) error {
	return WriteJSON(r.path, cfg)
}

package repository

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ezdemo/looprax/internal/model"
)

// BotRepository 的读改写由 Bot Service 的锁串行化。
type BotRepository struct {
	path string
}

func NewBotRepository(home string) *BotRepository {
	return &BotRepository{path: filepath.Join(home, "bots.json")}
}

func (r *BotRepository) Load() ([]model.Bot, error) {
	data, err := os.ReadFile(r.path)
	if os.IsNotExist(err) {
		return []model.Bot{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read bots: %w", err)
	}
	var file struct {
		Bots []model.Bot `json:"bots"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Bots == nil {
		return nil, fmt.Errorf("invalid bots configuration")
	}
	return file.Bots, nil
}

func (r *BotRepository) Save(bots []model.Bot) error {
	fields := map[string]json.RawMessage{}
	data, err := os.ReadFile(r.path)
	if err == nil {
		if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
			return fmt.Errorf("invalid bots configuration")
		}
		var previous []model.Bot
		if err := json.Unmarshal(fields["bots"], &previous); err != nil || previous == nil {
			return fmt.Errorf("invalid bots configuration")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	raw, err := json.Marshal(bots)
	if err != nil {
		return err
	}
	fields["bots"] = raw
	return WriteJSON(r.path, fields)
}

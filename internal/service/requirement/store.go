package requirement

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/repository"
)

// Store 缓存跨项目共享的需求列表。写入时重写整个 JSON 文件。
type Store struct {
	mu      sync.Mutex
	updates sync.Mutex
	list    []model.Requirement
	ready   bool
	path    string
}

func NewStore(home string) *Store {
	return &Store{path: filepath.Join(home, "requirements", "requirements.json")}
}

func (s *Store) Load() []model.Requirement {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ready {
		data, err := os.ReadFile(s.path)
		if err == nil {
			_ = json.Unmarshal(data, &s.list)
		}
		s.ready = true
	}
	if s.list == nil {
		s.list = []model.Requirement{}
	}
	return append([]model.Requirement{}, s.list...)
}

func (s *Store) Replace(list []model.Requirement) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = append([]model.Requirement{}, list...)
	_ = repository.WriteJSON(s.path, s.list)
}

func (s *Store) Append(item model.Requirement) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = append(s.list, item)
	return repository.WriteJSON(s.path, s.list)
}

func (s *Store) ByID(id string) (model.Requirement, int, bool) {
	list := s.Load()
	for i := range list {
		if list[i].ID == id {
			return list[i], i, true
		}
	}
	return model.Requirement{}, -1, false
}

// Mutate 对单个需求应用 fn 并持久化列表。
func (s *Store) Mutate(id string, fn func(*model.Requirement)) {
	s.updates.Lock()
	defer s.updates.Unlock()
	_ = s.Load()
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.list {
		if s.list[i].ID == id {
			fn(&s.list[i])
			break
		}
	}
	_ = repository.WriteJSON(s.path, s.list)
}

package schedule

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/repository"
)

// Path 是单个工作区的任务文件。
func Path(home, app string) string {
	return filepath.Join(home, "workspace", app, "schedules", "schedules.json")
}

// Store 缓存单个工作区的任务列表。
type Store struct {
	mu      sync.Mutex
	updates sync.Mutex
	tasks   []model.ScheduledTask
	ready   bool
	path    string
}

func NewStore(path string) *Store {
	return &Store{path: path}
}

func (s *Store) Load() []model.ScheduledTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ready {
		data, err := os.ReadFile(s.path)
		if err == nil {
			_ = json.Unmarshal(data, &s.tasks)
		}
		s.ready = true
	}
	if s.tasks == nil {
		s.tasks = []model.ScheduledTask{}
	}
	for i := range s.tasks {
		if s.tasks[i].Runs == nil {
			s.tasks[i].Runs = []model.ScheduleRun{}
		}
	}
	raw, _ := json.Marshal(s.tasks)
	var tasks []model.ScheduledTask
	_ = json.Unmarshal(raw, &tasks)
	return tasks
}

func (s *Store) Save(tasks []model.ScheduledTask) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := repository.WriteJSON(s.path, tasks); err != nil {
		return err
	}
	s.tasks = tasks
	return nil
}

func (s *Store) Mutate(id string, fn func(*model.ScheduledTask)) {
	s.updates.Lock()
	defer s.updates.Unlock()
	_ = s.Load()
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.tasks {
		if s.tasks[i].ID == id {
			fn(&s.tasks[i])
			break
		}
	}
	_ = repository.WriteJSON(s.path, s.tasks)
}

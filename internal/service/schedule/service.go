package schedule

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ezdemo/looprax/internal/model"
)

// Fail 是 Loopra API 约定的失败。部分校验错误沿用 Java 的 HTTP 200。
type Fail struct {
	Status  int
	Message string
}

func (f *Fail) Error() string   { return f.Message }
func (f *Fail) HTTPStatus() int { return f.Status }

func fail(status int, message string) error {
	return &Fail{Status: status, Message: message}
}

// Service 管理一个工作区的任务列表，并与进程级 Ticker 协作。
type Service struct {
	store  *Store
	ticker *Ticker
}

func NewService(store *Store, ticker *Ticker) *Service {
	return &Service{store: store, ticker: ticker}
}

func (s *Service) Store() *Store { return s.store }

func (s *Service) Ticker() *Ticker { return s.ticker }

func (s *Service) List() []model.ScheduledTask { return s.store.Load() }

func (s *Service) SetRunning(key string, on bool) { s.ticker.SetRunning(key, on) }

func (s *Service) HasPrefix(prefix string) bool { return s.ticker.HasPrefix(prefix) }

func (s *Service) Stop() { s.ticker.Stop() }

func (s *Service) Get(id string) (model.ScheduledTask, error) {
	for _, task := range s.store.Load() {
		if task.ID == id {
			return task, nil
		}
	}
	return model.ScheduledTask{}, fail(http.StatusOK, "定时任务不存在: "+id)
}

func (s *Service) Create(body []byte) (model.ScheduledTask, error) {
	s.store.updates.Lock()
	defer s.store.updates.Unlock()
	var task model.ScheduledTask
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil || json.Unmarshal(body, &task) != nil {
		return model.ScheduledTask{}, fail(http.StatusOK, "请求体不能为空")
	}
	if err := ValidateTask(task, fields, true); err != nil {
		return model.ScheduledTask{}, fail(http.StatusOK, err.Error())
	}
	now := time.Now().UnixMilli()
	if task.ID == "" {
		task.ID = NewID()
	}
	task.CreatedAt = now
	task.UpdatedAt = now
	task.LastRunAt, task.RunCount, task.Runs = 0, 0, []model.ScheduleRun{}
	task.NextRunAt = NextRunAt(task)
	tasks := s.store.Load()
	replaced := false
	for i := range tasks {
		if tasks[i].ID == task.ID {
			tasks[i], replaced = task, true
			break
		}
	}
	if !replaced {
		tasks = append(tasks, task)
	}
	if err := s.store.Save(tasks); err != nil {
		return model.ScheduledTask{}, fail(http.StatusInternalServerError, err.Error())
	}
	return task, nil
}

func (s *Service) Update(id string, body []byte) (model.ScheduledTask, error) {
	s.store.updates.Lock()
	defer s.store.updates.Unlock()
	var patch model.ScheduledTask
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil || json.Unmarshal(body, &patch) != nil {
		return model.ScheduledTask{}, fail(http.StatusOK, "请求体不能为空")
	}
	if err := ValidateTask(patch, fields, false); err != nil {
		return model.ScheduledTask{}, fail(http.StatusOK, err.Error())
	}
	found := false
	tasks := s.store.Load()
	for i := range tasks {
		if tasks[i].ID != id {
			continue
		}
		existing, _ := json.Marshal(tasks[i])
		merged := map[string]json.RawMessage{}
		_ = json.Unmarshal(existing, &merged)
		for _, key := range []string{"name", "sessionName", "sessionMode", "cronExpr", "intervalSec", "message"} {
			if raw, ok := fields[key]; ok && string(raw) != "null" {
				merged[key] = raw
			}
		}
		merged["enabled"], _ = json.Marshal(patch.Enabled)
		raw, _ := json.Marshal(merged)
		_ = json.Unmarshal(raw, &patch)
		base := patch
		base.LastRunAt = 0
		patch.NextRunAt = NextRunAt(base)
		patch.UpdatedAt = time.Now().UnixMilli()
		tasks[i] = patch
		found = true
		break
	}
	if !found {
		return model.ScheduledTask{}, fail(http.StatusOK, "定时任务不存在: "+id)
	}
	if err := s.store.Save(tasks); err != nil {
		return model.ScheduledTask{}, fail(http.StatusInternalServerError, err.Error())
	}
	return patch, nil
}

func (s *Service) Delete(id string) error {
	s.store.updates.Lock()
	defer s.store.updates.Unlock()
	tasks := s.store.Load()
	next := make([]model.ScheduledTask, 0, len(tasks))
	for _, task := range tasks {
		if task.ID == id {
			continue
		}
		next = append(next, task)
	}
	if err := s.store.Save(next); err != nil {
		return fail(http.StatusInternalServerError, err.Error())
	}
	return nil
}

func (s *Service) Toggle(id string) (model.ScheduledTask, error) {
	s.store.updates.Lock()
	defer s.store.updates.Unlock()
	tasks := s.store.Load()
	var updated model.ScheduledTask
	found := false
	for i := range tasks {
		if tasks[i].ID != id {
			continue
		}
		tasks[i].Enabled = !tasks[i].Enabled
		base := tasks[i]
		base.LastRunAt = 0
		tasks[i].NextRunAt = NextRunAt(base)
		tasks[i].UpdatedAt = time.Now().UnixMilli()
		updated = tasks[i]
		found = true
		break
	}
	if !found {
		return model.ScheduledTask{}, fail(http.StatusOK, "定时任务不存在: "+id)
	}
	if err := s.store.Save(tasks); err != nil {
		return model.ScheduledTask{}, fail(http.StatusInternalServerError, err.Error())
	}
	return updated, nil
}

func (s *Service) TryStart(key string) bool { return s.ticker.TryStart(key) }

func (s *Service) Finish(key string) { s.ticker.Finish(key) }

// Scan 对到期任务抢占执行槽，并在槽位可用时调用 run。
func (s *Service) Scan(app string, run func(model.ScheduledTask)) {
	now := time.Now().UnixMilli()
	for _, task := range s.store.Load() {
		if !task.Enabled || task.NextRunAt <= 0 || task.NextRunAt > now {
			continue
		}
		key := app + ":" + task.ID
		if !s.ticker.TryStart(key) {
			continue
		}
		go func(task model.ScheduledTask, key string) {
			defer s.ticker.Finish(key)
			if !s.ticker.Acquire() {
				return
			}
			defer s.ticker.Release()
			run(task)
		}(task, key)
	}
}

// Record 前插一条执行记录，并刷新下次执行时间。
func (s *Service) Record(id string, run model.ScheduleRun, reply string, runErr error) {
	s.store.Mutate(id, func(t *model.ScheduledTask) {
		t.Runs = append([]model.ScheduleRun{run}, t.Runs...)
		t.RunCount++
		t.LastRunAt = run.FinishedAt
		if len(reply) > 200 {
			t.LastResult = reply[:200]
		} else {
			t.LastResult = reply
		}
		if runErr != nil {
			t.LastError = runErr.Error()
		} else {
			t.LastError = ""
		}
		t.NextRunAt = NextRunAt(*t)
		t.UpdatedAt = time.Now().UnixMilli()
	})
}

func NewID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

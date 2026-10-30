package controller

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/service/schedule"
)

const scheduleInterval = 15 * time.Second

func (s *Controller) startScheduleTicker(interval time.Duration) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-s.tasks.Ticker().Done():
				return
			case <-t.C:
				if s.agent == nil {
					continue
				}
				for _, project := range s.projectList() {
					hash, _ := project["hash"].(string)
					if view, err := s.projectRuntime(hash); err == nil {
						view.scheduleScan()
					}
				}
				s.scanPluginSchedules()
				s.scanRequirements()
			}
		}
	}()
}

func (s *Controller) scanPluginSchedules() {
	if s.plugins == nil || s.agent == nil || s.tasks == nil {
		return
	}
	now := time.Now().UnixMilli()
	for _, task := range s.plugins.ScheduledTasks() {
		if !task.Enabled || task.NextRunAt <= 0 || task.NextRunAt > now {
			continue
		}
		key := "plugin:" + task.ID
		if !s.tasks.TryStart(key) {
			continue
		}
		go func(task model.ScheduledTask, key string) {
			defer s.tasks.Finish(key)
			if !s.tasks.Ticker().Acquire() {
				return
			}
			defer s.tasks.Ticker().Release()
			s.executePluginSchedule(context.Background(), task)
		}(task, key)
	}
}

// scheduleScan 触发所有已启用且 nextRunAt 到期的任务。
func (s *Controller) scheduleScan() {
	s.tasks.Scan(s.agent.App(), func(task model.ScheduledTask) {
		s.executeScheduledTask(context.Background(), task, false)
	})
}

// schedulesController 分发 /api/schedules 相关端点。
func (s *Controller) schedulesController(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/schedules"), "/")
	id, sub := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		id, sub = rest[:i], rest[i+1:]
	}
	switch {
	case id == "" && r.Method == http.MethodPost:
		s.schedulesCreate(w, r)
	case id == "":
		s.schedulesList(w)
	case sub == "" && r.Method == http.MethodPut:
		s.schedulesUpdate(w, r, id)
	case sub == "" && r.Method == http.MethodDelete:
		s.schedulesDelete(w, id)
	case sub == "" && r.Method == http.MethodGet:
		s.scheduleGet(w, id)
	case sub == "toggle" && r.Method == http.MethodPost:
		s.schedulesToggle(w, id)
	case sub == "run" && r.Method == http.MethodPost:
		s.schedulesRunNow(w, id)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) schedulesList(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, s.tasks.List())
}

func (s *Controller) scheduleGet(w http.ResponseWriter, id string) {
	task, err := s.tasks.Get(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, task)
}

func (s *Controller) schedulesCreate(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	task, err := s.tasks.Create(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, task)
}

func (s *Controller) schedulesUpdate(w http.ResponseWriter, r *http.Request, id string) {
	body, _ := io.ReadAll(r.Body)
	task, err := s.tasks.Update(id, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, task)
}

func (s *Controller) schedulesDelete(w http.ResponseWriter, id string) {
	if err := s.tasks.Delete(id); err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, "已删除")
}

func (s *Controller) schedulesToggle(w http.ResponseWriter, id string) {
	task, err := s.tasks.Toggle(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, task)
}

// schedulesRunNow 同步执行一次并返回回复。
func (s *Controller) schedulesRunNow(w http.ResponseWriter, id string) {
	task, err := s.tasks.Get(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	key := s.agent.App() + ":" + id
	if !s.tasks.TryStart(key) {
		writeFail(w, http.StatusBadRequest, "定时任务正在执行")
		return
	}
	defer s.tasks.Finish(key)
	reply := s.executeScheduledTask(nil, task, true)
	writeOK(w, http.StatusOK, reply)
}

// executeScheduledTask 执行一个任务轮次；手动运行与调度运行的区别
// 仅在于会返回回复。
func (s *Controller) executeScheduledTask(ctx context.Context, task model.ScheduledTask, manual bool) string {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	run := model.ScheduleRun{
		ID: schedule.NewID(), StartedAt: time.Now().UnixMilli(),
		Status: "running", Message: task.Message,
	}
	if task.SessionMode == "independent" {
		run.SessionName = "automation-" + strings.ReplaceAll(run.ID, "-", "")
	} else {
		run.SessionName = task.SessionName
	}
	reply, err := s.runTurnQuiet(ctx, run.SessionName, task.Message)
	run.FinishedAt = time.Now().UnixMilli()
	if err != nil {
		run.Status = "failed"
		run.Error = err.Error()
	} else {
		run.Status = "completed"
		run.Result = reply
	}
	s.tasks.Record(task.ID, run, reply, err)
	return reply
}

func (s *Controller) executePluginSchedule(ctx context.Context, task model.ScheduledTask) string {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	run := model.ScheduleRun{
		ID: schedule.NewID(), StartedAt: time.Now().UnixMilli(),
		Status: "running", Message: task.Message,
		SessionName: "automation-" + strings.ReplaceAll(task.ID, "-", ""),
	}
	view, err := s.projectRuntime(chatWorkspace)
	var reply string
	if err == nil {
		reply, err = view.runTurnQuiet(ctx, run.SessionName, task.Message)
	}
	run.FinishedAt = time.Now().UnixMilli()
	if err != nil {
		run.Status = "failed"
		run.Error = err.Error()
	} else {
		run.Status = "completed"
		run.Result = reply
	}
	if s.plugins != nil {
		s.plugins.RecordSchedule(task, run, reply, err)
	}
	return reply
}

func (s *Controller) runPluginSchedule(w http.ResponseWriter, r *http.Request, id string) {
	task, ok := s.pluginSchedule(id)
	if !ok {
		writeFail(w, http.StatusNotFound, "定时任务不存在: "+id)
		return
	}
	key := "plugin:" + id
	if s.tasks == nil || !s.tasks.TryStart(key) {
		writeFail(w, http.StatusBadRequest, "定时任务正在执行")
		return
	}
	defer s.tasks.Finish(key)
	reply := s.executePluginSchedule(r.Context(), task)
	writeOK(w, http.StatusOK, reply)
}

func (s *Controller) pluginSchedule(id string) (model.ScheduledTask, bool) {
	if s.plugins == nil {
		return model.ScheduledTask{}, false
	}
	for _, task := range s.plugins.ScheduledTasks() {
		if task.ID == id {
			return task, true
		}
	}
	return model.ScheduledTask{}, false
}

// explicitEnabled 报告原始请求体是否带有 enabled 键。
func explicitEnabled(body []byte) bool {
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil {
		return false
	}
	_, ok := raw["enabled"]
	return ok
}

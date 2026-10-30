package model

// ScheduledTask 对应 Java 实体（workspace-schedules.json）。
type ScheduledTask struct {
	ID          string        `json:"id"`
	Name        string        `json:"name,omitempty"`
	SessionName string        `json:"sessionName,omitempty"`
	SessionMode string        `json:"sessionMode,omitempty"` // independent | existing
	CronExpr    string        `json:"cronExpr,omitempty"`
	IntervalSec int64         `json:"intervalSec,omitempty"`
	Message     string        `json:"message"`
	Enabled     bool          `json:"enabled"`
	LastRunAt   int64         `json:"lastRunAt"`
	NextRunAt   int64         `json:"nextRunAt"`
	RunCount    int           `json:"runCount"`
	LastResult  string        `json:"lastResult,omitempty"`
	LastError   string        `json:"lastError,omitempty"`
	Runs        []ScheduleRun `json:"runs"`
	CreatedAt   int64         `json:"createdAt"`
	UpdatedAt   int64         `json:"updatedAt"`
	Plugin      bool          `json:"plugin,omitempty"`
}

// ScheduleRun 是一条执行记录（前插，不设上限）。
type ScheduleRun struct {
	ID          string `json:"id"`
	StartedAt   int64  `json:"startedAt"`
	FinishedAt  int64  `json:"finishedAt"`
	Status      string `json:"status"`
	Message     string `json:"message"`
	SessionName string `json:"sessionName,omitempty"`
	Result      string `json:"result,omitempty"`
	Error       string `json:"error,omitempty"`
}

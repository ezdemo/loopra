package model

// Requirement 对应 Java 实体，以单个 JSON 数组存储于
// ~/.loopra/requirements/requirements.json（跨项目共享）。
type Requirement struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Description     string `json:"description,omitempty"`
	Priority        string `json:"priority"` // high/medium/low
	ProjectHash     string `json:"projectHash"`
	ProjectName     string `json:"projectName,omitempty"`
	Status          string `json:"status"`       // todo/doing/done/failed
	ScheduleMode    string `json:"scheduleMode"` // immediate/scheduled
	Model           string `json:"model,omitempty"`
	ModelChannelID  string `json:"modelChannelId,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	Hitl            string `json:"hitl,omitempty"`
	ApprovalPending bool   `json:"approvalPending"`
	ScheduledAt     int64  `json:"scheduledAt"`
	Summary         string `json:"summary"`
	SessionName     string `json:"sessionName"`
	CreatedAt       int64  `json:"createdAt"`
	UpdatedAt       int64  `json:"updatedAt"`
}

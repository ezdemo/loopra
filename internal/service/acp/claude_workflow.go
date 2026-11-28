package acp

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Claude Code runs local_workflow tasks in the background: the ACP prompt
// returns end_turn while a workflow is still running, and the adapter later
// continues the same turn when the task finishes. We subscribe to the raw
// SDK messages so the turn can stay open until the continuation lands.
const claudeWorkflowMethod = "_claude/sdkMessage"

// Grace between a terminal task_notification and its continuation: if no
// user wakeup arrives within the window the task counts as finished.
const claudeWorkflowNotifyGrace = time.Minute

// Upper bound for a single turn waiting on workflow follow-ups.
const claudeWorkflowWaitLimit = 2 * time.Hour

var errClaudeWorkflowTimeout = errors.New("等待 Claude Code Workflow 超时，已请求停止本轮")
var errClaudeWorkflowFailed = errors.New("Claude Code 处理 Workflow 结果失败")

// claudeWorkflowFilters is the raw SDK message subscription Loopra asks the
// Claude Code adapter to mirror through _claude/sdkMessage.
var claudeWorkflowFilters = []map[string]string{
	{"type": "system", "subtype": "task_started"},
	{"type": "system", "subtype": "task_notification"},
	{"type": "user", "origin": "task-notification"},
	{"type": "result", "origin": "task-notification"},
}

// claudeWorkflowMeta merges the Workflow subscription into session-setup
// _meta without mutating the caller's maps; non-Claude agents keep meta as-is.
func (c *Client) claudeWorkflowMeta(meta map[string]any) map[string]any {
	if !c.claudeWorkflows {
		return meta
	}
	original, _ := meta["claudeCode"].(map[string]any)
	claude := make(map[string]any, len(original)+1)
	for key, value := range original {
		claude[key] = value
	}
	claude["emitRawSDKMessages"] = claudeWorkflowFilters
	outer := make(map[string]any, len(meta)+1)
	for key, value := range meta {
		outer[key] = value
	}
	outer["claudeCode"] = claude
	return outer
}

// claudeWorkflowMessage is the raw Claude SDK message mirrored through
// _claude/sdkMessage; only fields the tracker consumes are decoded.
type claudeWorkflowMessage struct {
	Type           string `json:"type"`
	Subtype        string `json:"subtype"`
	TaskID         string `json:"task_id"`
	TaskType       string `json:"task_type"`
	RunID          string `json:"run_id"`
	Status         string `json:"status"`
	IsBackgrounded *bool  `json:"is_backgrounded"`
	NumTurns       int    `json:"num_turns"`
	IsError        bool   `json:"is_error"`
	Origin         struct {
		Kind  string `json:"kind"`
		RunID string `json:"runId"`
	} `json:"origin"`
}

// HandleExtensionMethod receives extension notifications on the SDK's serial
// notification goroutine; it only feeds the in-memory tracker, never SSE or disk.
func (c *Client) HandleExtensionMethod(_ context.Context, method string, params json.RawMessage) (any, error) {
	if method != claudeWorkflowMethod {
		return nil, acpsdk.NewMethodNotFound(method)
	}
	var notice struct {
		SessionID string                `json:"sessionId"`
		Message   claudeWorkflowMessage `json:"message"`
	}
	if err := json.Unmarshal(params, &notice); err != nil {
		return nil, acpsdk.NewInvalidParams(nil)
	}
	c.mu.Lock()
	delivery := c.sessionConns[notice.SessionID]
	// A session being set up (load/resume) must not feed workflow messages
	// into its tracker; a live turn on a different session keeps observing.
	replaying := c.replaying && c.setupOwner == delivery
	c.mu.Unlock()
	if delivery != nil && !replaying {
		if turn := delivery.currentTurn(); turn != nil && turn.workflows != nil {
			turn.workflows.observe(notice.Message, time.Now())
		}
	}
	return nil, nil
}

// claudeWorkflowRun is the latest observed run of one pending workflow task.
type claudeWorkflowRun struct {
	runID      string
	notifiedAt time.Time
	continuing bool
}

// claudeWorkflowWait tracks the background workflows reported during one
// turn. A turn ends when every task either produced its follow-up result or
// gave up waiting for a continuation.
type claudeWorkflowWait struct {
	mu      sync.Mutex
	changed chan struct{}
	tasks   map[string]claudeWorkflowRun // task id -> current run (only pending tasks)
	failed  bool
}

func newClaudeWorkflowWait() *claudeWorkflowWait {
	return &claudeWorkflowWait{changed: make(chan struct{}, 1), tasks: make(map[string]claudeWorkflowRun)}
}

func (w *claudeWorkflowWait) observe(message claudeWorkflowMessage, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	switch message.Type {
	case "system":
		if message.TaskID == "" {
			return
		}
		task, known := w.tasks[message.TaskID]
		switch message.Subtype {
		case "task_started":
			if message.TaskType != "local_workflow" || (message.IsBackgrounded != nil && !*message.IsBackgrounded) || (known && task.runID >= message.RunID) {
				return
			}
			w.tasks[message.TaskID] = claudeWorkflowRun{runID: message.RunID}
		case "task_notification":
			if !known || !task.notifiedAt.IsZero() || (task.runID != "" && message.RunID != "" && task.runID != message.RunID) {
				return
			}
			switch message.Status {
			case "completed", "failed", "stopped":
			default:
				return
			}
			if task.runID == "" {
				task.runID = message.RunID
			}
			task.notifiedAt = now
			w.tasks[message.TaskID] = task
		default:
			return
		}
	case "user", "result":
		if message.Origin.Kind != "task-notification" || (message.Type == "result" && message.NumTurns == 0 && !message.IsError) {
			return
		}
		id := w.followupTask(message.Origin.RunID)
		if id == "" {
			return
		}
		if message.Type == "user" {
			task := w.tasks[id]
			task.continuing = true
			w.tasks[id] = task
		} else {
			delete(w.tasks, id)
			w.failed = w.failed || message.IsError
		}
	default:
		return
	}
	select {
	case w.changed <- struct{}{}:
	default:
	}
}

// followupTask resolves which pending task a continuation belongs to.
// Called under mu. Older SDKs do not attach a run id; do not guess if ambiguous.
func (w *claudeWorkflowWait) followupTask(runID string) string {
	legacy := ""
	ambiguous := false
	for id, task := range w.tasks {
		if task.notifiedAt.IsZero() {
			continue
		}
		if runID != "" && runID == task.runID {
			return id
		}
		if runID != "" && task.runID != "" {
			continue
		}
		if legacy == "" {
			legacy = id
		} else {
			ambiguous = true
		}
	}
	if ambiguous {
		return ""
	}
	return legacy
}

// pending drops notified tasks whose continuation never arrived and reports
// the remaining count, the next wake instant and whether a result failed.
func (w *claudeWorkflowWait) pending(now time.Time, deadline time.Time) (int, time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for id, task := range w.tasks {
		if task.notifiedAt.IsZero() || task.continuing {
			continue
		}
		expires := task.notifiedAt.Add(claudeWorkflowNotifyGrace)
		if !now.Before(expires) {
			delete(w.tasks, id)
		} else if expires.Before(deadline) {
			deadline = expires
		}
	}
	return len(w.tasks), deadline, w.failed
}

// wait blocks until every observed workflow task finished or the turn is
// cancelled / the agent connection drops.
func (w *claudeWorkflowWait) wait(ctx context.Context, disconnected <-chan struct{}) error {
	deadline := time.Now().Add(claudeWorkflowWaitLimit)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		now := time.Now()
		count, next, failed := w.pending(now, deadline)
		if count == 0 {
			if failed {
				return errClaudeWorkflowFailed
			}
			return nil
		}
		if !now.Before(deadline) {
			return errClaudeWorkflowTimeout
		}
		timer := time.NewTimer(time.Until(next))
		var err error
		select {
		case <-ctx.Done():
			err = ctx.Err()
		case <-disconnected:
			err = ErrBroken
		case <-w.changed:
		case <-timer.C:
		}
		timer.Stop()
		if err != nil {
			return err
		}
	}
}

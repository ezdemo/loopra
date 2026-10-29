// Package requirement 负责需求的存储、校验和执行调度。
// 智能体轮次由调用方注入：本包不依赖 HTTP，也不依赖具体的 Agent。
package requirement

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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

// Project 是某个工作区上执行需求所需的能力。
type Project struct {
	SetMeta func(session string, overrides map[string]any)
	RunTurn func(ctx context.Context, session, prompt string) (string, error)
}

// Service 组合存储与并发槽。各项目运行时共享同一个实例。
type Service struct {
	store  *Store
	runner *Runner
}

func NewService(home string) *Service {
	return &Service{store: NewStore(home), runner: NewRunner()}
}

func (s *Service) List() []model.Requirement { return s.store.Load() }

func (s *Service) ByID(id string) (model.Requirement, int, bool) { return s.store.ByID(id) }

func (s *Service) Mutate(id string, fn func(*model.Requirement)) { s.store.Mutate(id, fn) }

func (s *Service) Begin(id string) bool { return s.runner.Begin(id) }

func (s *Service) End(id string) { s.runner.End(id) }

func (s *Service) Running(id string) bool { return s.runner.Running(id) }

func (s *Service) Register(id string, cancel context.CancelFunc) { s.runner.Register(id, cancel) }

func (s *Service) AcquireBlocking() { s.runner.AcquireBlocking() }

func (s *Service) Release() { s.runner.Release() }

type CreateInput struct {
	Title           string `json:"title"`
	Description     string `json:"description"`
	Priority        string `json:"priority"`
	ProjectHash     string `json:"projectHash"`
	ProjectName     string `json:"projectName"`
	ScheduleMode    string `json:"scheduleMode"`
	ScheduledAt     int64  `json:"scheduledAt"`
	Model           string `json:"model"`
	ModelChannelID  string `json:"modelChannelId"`
	ReasoningEffort string `json:"reasoningEffort"`
	Hitl            string `json:"hitl"`
}

func (s *Service) Create(body io.Reader, resolveProject func(hash string) (string, error)) (model.Requirement, error) {
	s.store.updates.Lock()
	defer s.store.updates.Unlock()
	var in CreateInput
	if err := json.NewDecoder(body).Decode(&in); err != nil {
		return model.Requirement{}, fail(http.StatusOK, "请求体不能为空")
	}
	if strings.TrimSpace(in.Title) == "" {
		return model.Requirement{}, fail(http.StatusOK, "需求标题不能为空")
	}
	if strings.TrimSpace(in.ProjectHash) == "" {
		return model.Requirement{}, fail(http.StatusOK, "必须选择项目")
	}
	priority := in.Priority
	if priority == "" {
		priority = "medium"
	}
	mode := in.ScheduleMode
	if mode == "" {
		mode = "immediate"
	}
	if mode != "immediate" && mode != "scheduled" {
		return model.Requirement{}, fail(http.StatusOK, "不支持的调度方式: "+mode)
	}
	if mode == "scheduled" && in.ScheduledAt <= time.Now().UnixMilli() {
		return model.Requirement{}, fail(http.StatusOK, "定时执行时间必须晚于当前时间")
	}
	if _, err := resolveProject(in.ProjectHash); err != nil {
		return model.Requirement{}, fail(http.StatusOK, "项目不存在: "+in.ProjectHash)
	}
	id := newID()
	now := time.Now().UnixMilli()
	item := model.Requirement{
		ID: id, Title: strings.TrimSpace(in.Title), Description: strings.TrimSpace(in.Description),
		Priority: priority, ProjectHash: in.ProjectHash, ProjectName: in.ProjectName, Status: "todo",
		ScheduleMode: mode, ScheduledAt: in.ScheduledAt,
		Model: in.Model, ModelChannelID: in.ModelChannelID,
		ReasoningEffort: in.ReasoningEffort, Hitl: in.Hitl,
		SessionName: "req_" + id, CreatedAt: now, UpdatedAt: now,
	}
	if mode != "scheduled" {
		item.ScheduledAt = 0
	}
	_ = s.store.Load()
	if err := s.store.Append(item); err != nil {
		return model.Requirement{}, fail(http.StatusInternalServerError, err.Error())
	}
	return item, nil
}

func (s *Service) Update(id string, body io.Reader) (model.Requirement, error) {
	var payload struct {
		Description *string `json:"description"`
		Priority    string  `json:"priority"`
	}
	_ = json.NewDecoder(body).Decode(&payload)
	if _, _, ok := s.store.ByID(id); !ok {
		return model.Requirement{}, fail(http.StatusOK, "需求不存在: "+id)
	}
	s.store.Mutate(id, func(req *model.Requirement) {
		if payload.Description != nil {
			req.Description = strings.TrimSpace(*payload.Description)
		}
		if payload.Priority != "" {
			req.Priority = payload.Priority
		}
		req.UpdatedAt = time.Now().UnixMilli()
	})
	item, _, ok := s.store.ByID(id)
	if !ok {
		return model.Requirement{}, fail(http.StatusOK, "需求不存在: "+id)
	}
	return item, nil
}

func (s *Service) Delete(id string) error {
	s.store.updates.Lock()
	defer s.store.updates.Unlock()
	if s.runner.Running(id) {
		return fail(http.StatusConflict, "请先中止正在执行的需求")
	}
	list := s.store.Load()
	next := make([]model.Requirement, 0, len(list))
	found := false
	for _, req := range list {
		if req.ID == id {
			found = true
			continue
		}
		next = append(next, req)
	}
	if !found {
		return fail(http.StatusOK, "需求不存在: "+id)
	}
	s.store.Replace(next)
	return nil
}

func (s *Service) Get(id string) (model.Requirement, error) {
	item, _, ok := s.store.ByID(id)
	if !ok {
		return model.Requirement{}, fail(http.StatusOK, "需求不存在: "+id)
	}
	return item, nil
}

// Start 把需求标为执行中。返回的是入队前的副本，供随后的轮次使用。
func (s *Service) Start(id string, setMeta func(session string, overrides map[string]any)) (model.Requirement, error) {
	item, _, ok := s.store.ByID(id)
	if !ok {
		return model.Requirement{}, fail(http.StatusOK, "需求不存在: "+id)
	}
	if item.Status != "todo" && item.Status != "failed" {
		return model.Requirement{}, fail(http.StatusOK, "需求正在执行或状态不允许触发: "+id)
	}
	if !s.runner.Begin(id) {
		return model.Requirement{}, fail(http.StatusOK, "需求正在执行或状态不允许触发: "+id)
	}
	if overrides := sessionOverrides(item); len(overrides) > 0 && setMeta != nil {
		setMeta(item.SessionName, overrides)
	}
	s.store.Mutate(id, func(req *model.Requirement) {
		req.Status = "doing"
		req.ApprovalPending = false
		req.UpdatedAt = time.Now().UnixMilli()
	})
	return item, nil
}

// Run 执行一个需求轮次，并在工具未提前声明结果时写回最终状态。
func (s *Service) Run(item model.Requirement, turn func(ctx context.Context, session, prompt string) (string, error)) {
	defer s.runner.End(item.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	s.runner.Register(item.ID, cancel)
	if !s.runner.Acquire(ctx) {
		return
	}
	defer s.runner.Release()
	reply, err := turn(ctx, item.SessionName, Prompt(item))
	summary := reply
	if len(summary) > 500 {
		summary = summary[:500]
	}
	s.store.Mutate(item.ID, func(req *model.Requirement) {
		if req.Status != "doing" {
			return
		}
		if err != nil {
			req.Status = "failed"
			req.Summary = "执行失败: " + err.Error()
		} else {
			req.Status = "done"
			req.Summary = summary
		}
		req.UpdatedAt = time.Now().UnixMilli()
	})
}

// Scan 触发已到期、仍为 todo 的需求。open 按项目提供执行能力。
func (s *Service) Scan(open func(projectHash string) (Project, error)) {
	now := time.Now().UnixMilli()
	for _, item := range s.store.Load() {
		if item.Status != "todo" || (item.ScheduleMode == "scheduled" && item.ScheduledAt > now) {
			continue
		}
		project, err := open(item.ProjectHash)
		if err != nil {
			continue
		}
		if !s.runner.Begin(item.ID) {
			continue
		}
		if overrides := sessionOverrides(item); len(overrides) > 0 && project.SetMeta != nil {
			project.SetMeta(item.SessionName, overrides)
		}
		s.store.Mutate(item.ID, func(req *model.Requirement) {
			req.Status = "doing"
			req.UpdatedAt = now
		})
		go s.Run(item, project.RunTurn)
	}
}

func (s *Service) Abort(id string) error {
	if _, _, ok := s.store.ByID(id); !ok {
		return fail(http.StatusOK, "需求不存在: "+id)
	}
	s.runner.Cancel(id)
	s.store.Mutate(id, func(req *model.Requirement) {
		req.Status = "todo"
		req.ApprovalPending = false
		req.UpdatedAt = time.Now().UnixMilli()
	})
	return nil
}

// Approval 处理需求上的待审批。pending 返回该会话当前待处理的审批 id。
func (s *Service) Approval(id, action string, pending func(session string) []string, resolve func(id, session, option string) error) (string, error) {
	if action != "approve" && action != "deny" {
		return "", fail(http.StatusOK, "审批操作必须为 approve 或 deny")
	}
	item, _, ok := s.store.ByID(id)
	if !ok {
		return "", fail(http.StatusOK, "需求不存在: "+id)
	}
	if item.Status != "doing" || !item.ApprovalPending {
		return "", fail(http.StatusOK, "需求不存在、未在执行中或没有待审批操作: "+id)
	}
	ids := pending(item.SessionName)
	if len(ids) == 0 {
		return "", fail(http.StatusOK, "需求不存在、未在执行中或没有待审批操作: "+id)
	}
	option := "reject_once"
	if action == "approve" {
		option = "allow_once"
	}
	for _, approvalID := range ids {
		_ = resolve(approvalID, item.SessionName, option)
	}
	s.store.Mutate(id, func(req *model.Requirement) {
		req.ApprovalPending = false
		req.UpdatedAt = time.Now().UnixMilli()
	})
	if action == "approve" {
		return "已同意，AI 将继续执行", nil
	}
	return "已拒绝，AI 将继续执行", nil
}

func (s *Service) MarkPending(sessionName string, pending bool) {
	for _, item := range s.store.Load() {
		if item.SessionName != sessionName {
			continue
		}
		s.store.Mutate(item.ID, func(req *model.Requirement) {
			req.ApprovalPending = pending
			req.UpdatedAt = time.Now().UnixMilli()
		})
	}
}

func Prompt(item model.Requirement) string {
	priority := map[string]string{"high": "高", "medium": "中", "low": "低"}[item.Priority]
	if priority == "" {
		priority = item.Priority
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "请处理需求「%s」（优先级：%s）。\n", item.Title, priority)
	if item.Description != "" {
		fmt.Fprintf(&sb, "\n需求描述：\n%s\n", item.Description)
	}
	sb.WriteString("\n完成后请给出总结。")
	return sb.String()
}

func sessionOverrides(item model.Requirement) map[string]any {
	overrides := map[string]any{}
	for key, value := range map[string]string{
		"model": item.Model, "modelChannelId": item.ModelChannelID,
		"reasoningEffort": item.ReasoningEffort, "hitl": item.Hitl,
	} {
		if value != "" {
			overrides[key] = value
		}
	}
	return overrides
}

func newID() string {
	buf := make([]byte, 16)
	if _, err := cryptorand.Read(buf); err != nil {
		return fmt.Sprintf("r%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)[:10]
}

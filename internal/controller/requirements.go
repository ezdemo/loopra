package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/service/requirement"
)

// requirementsController 分发 /api/requirements 相关端点。
func (s *Controller) requirementsController(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/requirements"), "/")
	id, sub := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		id, sub = rest[:i], rest[i+1:]
	}
	if id != "" {
		if item, _, ok := s.requirementByID(id); ok {
			view, err := s.projectRuntime(item.ProjectHash)
			if err != nil {
				writeFail(w, http.StatusBadRequest, err.Error())
				return
			}
			s = view
		}
	}
	switch {
	case id == "" && r.Method == http.MethodPost:
		s.requirementsCreate(w, r)
	case id == "":
		s.requirementsList(w)
	case sub == "":
		s.requirementItem(w, r, id)
	case sub == "comments":
		s.requirementComment(w, r, id)
	case sub == "messages":
		s.requirementMessages(w, r, id)
	case sub == "run" && r.Method == http.MethodPost:
		s.requirementRun(w, r, id)
	case sub == "approval" && r.Method == http.MethodPost:
		s.requirementApproval(w, r, id)
	case sub == "abort" && r.Method == http.MethodPost:
		s.requirementAbort(w, id)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) requirementByID(id string) (model.Requirement, int, bool) {
	return s.reqs.ByID(id)
}

func (s *Controller) requirementsMutate(id string, fn func(*model.Requirement)) {
	s.reqs.Mutate(id, fn)
}

func (s *Controller) requirementsList(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, s.reqs.List())
}

func (s *Controller) requirementsCreate(w http.ResponseWriter, r *http.Request) {
	item, err := s.reqs.Create(r.Body, s.resolveProject)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, item)
}

func (s *Controller) requirementItem(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodPut:
		item, err := s.reqs.Update(id, r.Body)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeOK(w, http.StatusOK, item)
	case http.MethodDelete:
		if err := s.reqs.Delete(id); err != nil {
			writeErr(w, err)
			return
		}
		writeOK(w, http.StatusOK, "已删除")
	default:
		item, err := s.reqs.Get(id)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeOK(w, http.StatusOK, item)
	}
}

func (s *Controller) requirementRun(w http.ResponseWriter, r *http.Request, id string) {
	item, err := s.reqs.Start(id, func(session string, overrides map[string]any) {
		s.sessionMetaSet(session, overrides)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	go s.reqs.Run(item, s.runTurnQuiet)
	writeOK(w, http.StatusOK, "已入队执行")
}

func (s *Controller) scanRequirements() {
	s.reqs.Scan(func(hash string) (requirement.Project, error) {
		view, err := s.projectRuntime(hash)
		if err != nil {
			return requirement.Project{}, err
		}
		return requirement.Project{
			SetMeta: func(session string, overrides map[string]any) {
				view.sessionMetaSet(session, overrides)
			},
			RunTurn: view.runTurnQuiet,
		}, nil
	})
}

func (s *Controller) requirementApproval(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Action string `json:"action"` // approve | deny
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	message, err := s.reqs.Approval(id, body.Action, func(session string) []string {
		pending := s.permissions.Pending(session)
		ids := make([]string, 0, len(pending))
		for _, p := range pending {
			ids = append(ids, p.ID)
		}
		return ids
	}, s.permissions.Resolve)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, message)
}

func (s *Controller) requirementAbort(w http.ResponseWriter, id string) {
	if err := s.reqs.Abort(id); err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, "已取消")
}

func (s *Controller) requirementComment(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Text string `json:"text"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Text) == "" {
		writeFail(w, http.StatusOK, "评论内容不能为空")
		return
	}
	item, _, ok := s.requirementByID(id)
	if !ok {
		writeFail(w, http.StatusOK, "需求不存在: "+id)
		return
	}
	if err := s.appendUserMessage(r.Context(), item.SessionName, body.Text); err != nil {
		writeFail(w, http.StatusInternalServerError, "评论写入失败: "+err.Error())
		return
	}
	// Java 在收到评论时异步应答已完成的需求。
	if (item.Status == "done" || item.Status == "failed") && s.reqs.Begin(id) {
		item2 := item
		text := body.Text
		go func() {
			defer s.reqs.End(item2.ID)
			s.reqs.AcquireBlocking()
			defer s.reqs.Release()
			cctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
			defer cancel()
			s.reqs.Register(item2.ID, cancel)
			_, _ = s.runTurnQuiet(cctx, item2.SessionName, text)
		}()
	}
	writeOK(w, http.StatusOK, "已提交")
}

func (s *Controller) requirementMessages(w http.ResponseWriter, r *http.Request, id string) {
	item, err := s.reqs.Get(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, http.StatusOK, s.sessionMessages(r.Context(), item.SessionName))
}

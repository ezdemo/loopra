package controller

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/service/memory"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func (s *Controller) installMemoryTools() {
	if s.registry == nil || s.memories == nil || s.agent == nil {
		return
	}
	project := s.agent.App()
	if project == chatWorkspace {
		project = ""
	}
	for _, entry := range tools.MemoryTools(s.memories, project) {
		s.registry.Add(entry)
	}
}

const memoryInstruction = `长期记忆：新会话首次处理任务时，先用 memory_search(action="list") 查看全局和当前项目的记忆目录；目录只含 ID 和标题，依据完整对话判断需要哪些信息，再用 action="read"、scope、id 读取正文。目录较多时分页，或用 action="search" 配合 query 搜索；不要默认读取全部正文，也不必每轮重复列目录。用 memory 保存、更新或删除可靠且可复用的信息，一条记忆一个主题，标题具体说明用途；已有主题先读取原条目，以最新 revision 更新，避免重复。个人偏好和本机环境使用 global，项目背景和约定使用 project；纯聊天仅使用 global。记忆仅供参考，以当前用户要求为准；环境信息使用前核实，不记录密钥或临时任务进度。`

func (s *Controller) turnInstruction(workspace string) string {
	text := s.systemInstruction(workspace)
	if s.memories == nil || s.agent == nil {
		return text
	}
	return text + "\n\n" + memoryInstruction
}

func (s *Controller) memoryProject(r *http.Request) (string, error) {
	switch r.URL.Query().Get("scope") {
	case "global":
		return "", nil
	case "project":
		hash := r.URL.Query().Get("workspaceHash")
		if hash == "" || hash == chatWorkspace || hash == "." || hash == ".." || filepath.Base(hash) != hash || strings.ContainsAny(hash, `/\:`) {
			return "", memory.ErrInvalid
		}
		if _, err := s.resolveProject(hash); err != nil {
			return "", memory.ErrInvalid
		}
		return hash, nil
	default:
		return "", memory.ErrInvalid
	}
}

func memoryFailure(w http.ResponseWriter, err error) {
	status, reason := http.StatusInternalServerError, "memory_storage_failed"
	switch {
	case errors.Is(err, memory.ErrInvalid):
		status, reason = http.StatusBadRequest, "invalid_memory"
	case errors.Is(err, memory.ErrNotFound):
		status, reason = http.StatusNotFound, "memory_not_found"
	case errors.Is(err, memory.ErrConflict):
		status, reason = http.StatusConflict, "memory_conflict"
	}
	writeFailReason(w, status, err.Error(), reason)
}

func (s *Controller) memoriesController(w http.ResponseWriter, r *http.Request) {
	project, err := s.memoryProject(r)
	if err != nil {
		memoryFailure(w, err)
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		entries, err := s.memories.List(project, r.URL.Query().Get("query"))
		if err != nil {
			memoryFailure(w, err)
			return
		}
		writeOK(w, http.StatusOK, entries)
		return
	}
	if r.Method == http.MethodDelete {
		revision, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
		if err != nil {
			memoryFailure(w, memory.ErrInvalid)
			return
		}
		if err := s.memories.Delete(project, r.PathValue("id"), revision); err != nil {
			memoryFailure(w, err)
			return
		}
		writeOK(w, http.StatusOK, "记忆已删除")
		return
	}
	var entry model.Memory
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if decoder.Decode(&entry) != nil || decoder.Decode(new(any)) != io.EOF {
		memoryFailure(w, memory.ErrInvalid)
		return
	}
	if (r.Method == http.MethodPost && (entry.ID != "" || entry.Revision != 0)) || (r.Method == http.MethodPut && (entry.ID != "" && entry.ID != r.PathValue("id"))) {
		memoryFailure(w, memory.ErrInvalid)
		return
	}
	entry.ID = r.PathValue("id")
	saved, err := s.memories.Save(project, entry, "user")
	if err != nil {
		memoryFailure(w, err)
		return
	}
	writeOK(w, http.StatusOK, saved)
}

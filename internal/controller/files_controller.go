package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
)

// filesController 实现 /api/files 相关接口（树/搜索/粘贴）。
func (s *Controller) filesController(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/tree"):
		s.filesTree(w, r)
	case strings.HasSuffix(r.URL.Path, "/paste"):
		var body struct {
			Content string `json:"content"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Content == "" {
			writeFail(w, http.StatusBadRequest, "粘贴内容不能为空")
			return
		}
		if len(body.Content) > 4<<20 {
			writeFail(w, http.StatusBadRequest, "粘贴内容超过 4 MiB 限制")
			return
		}
		if s.agent.App() == "__loopra_chat__" {
			writeFail(w, http.StatusBadRequest, "纯聊天模式不会把输入保存到工作区")
			return
		}
		name := "paste-" + newUUIDv4() + ".txt"
		dir, err := fsutil.SafeJoin(s.workspaceRoot(), filepath.Join(".loopra", "paste"))
		if err != nil {
			writeFail(w, http.StatusBadRequest, "粘贴保存目录无效")
			return
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body.Content), 0o644); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{
			"name": name, "path": ".loopra/paste/" + name,
			"chars": len(utf16.Encode([]rune(body.Content))), "bytes": len(body.Content),
		})
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) workspaceRoot() string {
	if s.cfg != nil && s.cfg.WorkspaceDir != "" {
		return s.cfg.WorkspaceDir
	}
	return filepath.Join(s.home, "defaultWorkSpace")
}

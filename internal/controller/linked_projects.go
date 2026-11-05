package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/service/projectlinks"
)

type linkedProject = projectlinks.Project

func (s *Controller) linkedProjects(hash string, requested []string) ([]linkedProject, error) {
	return projectlinks.New(s.home, &s.state.files).Resolve(hash, requested)
}

func projectRoots(projects []linkedProject) []string {
	roots := make([]string, 0, len(projects))
	for _, project := range projects {
		roots = append(roots, project.Path)
	}
	return roots
}

func projectEnvironment(workspace string, projects []linkedProject) string {
	var text strings.Builder
	fmt.Fprintf(&text, "\n\n[项目工作区]\n主项目根目录: %s\n相对路径与默认命令工作目录均以主项目为准。\n", workspace)
	for _, project := range projects {
		fmt.Fprintf(&text, "副项目: %s\n根目录: %s\n", project.Name, project.Path)
	}
	if len(projects) > 0 {
		text.WriteString("访问副项目时使用其绝对路径；在副项目执行命令时显式指定工作目录。")
	}
	text.WriteString("\n工作区写入限制开启时，write 和 edit 仅允许写入主项目及上述副项目，仍须遵守工具权限与审批规则。")
	return text.String()
}

func (s *Controller) linkedProjectEnvironment() string {
	projects := make([]linkedProject, 0, len(s.linkedProjectRoots))
	for _, path := range s.linkedProjectRoots {
		projects = append(projects, linkedProject{Name: filepath.Base(path), Path: path})
	}
	return projectEnvironment(s.workspaceRoot(), projects)
}

func (s *Controller) workspaceLinksController(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	var body struct {
		Hashes []string `json:"linkedProjectHashes"`
		Paths  []string `json:"linkedProjectPaths"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || (body.Hashes == nil && body.Paths == nil) {
		writeFail(w, http.StatusBadRequest, "缺少 linkedProjectHashes 或 linkedProjectPaths 列表")
		return
	}
	if err := projectlinks.New(s.home, &s.state.files).Save(hash, body.Hashes, body.Paths); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, projectlinks.ErrStorage) {
			status = http.StatusInternalServerError
		}
		writeFail(w, status, err.Error())
		return
	}
	for _, project := range s.projectList() {
		if project["hash"] == hash {
			writeOK(w, http.StatusOK, project)
			return
		}
	}
	writeFail(w, http.StatusBadRequest, "项目不存在")
}

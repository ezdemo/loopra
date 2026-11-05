// Package projectlinks 管理项目默认关联及当前执行的有效副项目。
package projectlinks

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/repository"
)

const MaxProjects = 8
const chatWorkspace = "__loopra_chat__"

var ErrStorage = errors.New("保存项目关联失败")

type Project struct {
	Hash string
	Name string
	Path string
}

type Service struct {
	home  string
	files *sync.Mutex
}

// files 与项目注册、改名共用同一把元数据锁。
func New(home string, files *sync.Mutex) *Service {
	return &Service{home: home, files: files}
}

func Hashes(meta map[string]any) []string {
	return stringList(meta, "linkedProjectHashes")
}

func Paths(meta map[string]any) []string {
	return stringList(meta, "linkedProjectPaths")
}

func stringList(meta map[string]any, key string) []string {
	var hashes []string
	switch values := meta[key].(type) {
	case []string:
		hashes = append(hashes, values...)
	case []any:
		for _, value := range values {
			if hash, ok := value.(string); ok {
				hashes = append(hashes, hash)
			}
		}
	}
	return hashes
}

func directory(path string) (Project, error) {
	path = strings.TrimSpace(path)
	if !filepath.IsAbs(path) {
		return Project{}, fmt.Errorf("关联目录必须是绝对路径: %s", path)
	}
	root, err := fsutil.Resolve(path)
	if err != nil {
		return Project{}, fmt.Errorf("关联目录不可用: %s: %w", path, err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return Project{}, fmt.Errorf("关联目录不可用: %s", path)
	}
	return Project{Name: filepath.Base(root), Path: root}, nil
}

func sameDirectory(left, right string) bool {
	relative, err := filepath.Rel(left, right)
	return err == nil && relative == "."
}

func containsDirectory(roots []string, path string) bool {
	for _, root := range roots {
		if sameDirectory(root, path) {
			return true
		}
	}
	return false
}

func validHash(hash string) bool {
	return hash != "" && hash != "." && hash != ".." && hash != chatWorkspace && !strings.ContainsAny(hash, `/\:`) && !filepath.IsAbs(hash)
}

func (s *Service) metadata(hash string) (map[string]any, error) {
	raw, err := os.ReadFile(filepath.Join(s.home, "workspace", hash, "workspace.json"))
	if err != nil {
		return nil, err
	}
	meta := map[string]any{}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	return meta, nil
}

func (s *Service) registered(hash string) (Project, error) {
	if !validHash(hash) {
		return Project{}, fmt.Errorf("关联项目不存在或未注册: %s", hash)
	}
	meta, err := s.metadata(hash)
	if err != nil {
		return Project{}, fmt.Errorf("读取关联项目 %s 失败: %w", hash, err)
	}
	path, _ := meta["path"].(string)
	project, err := directory(path)
	if err != nil {
		return Project{}, fmt.Errorf("关联项目不存在或目录不可用: %s", hash)
	}
	name, _ := meta["displayName"].(string)
	if name == "" {
		name = filepath.Base(path)
	}
	project.Hash, project.Name = hash, name
	return project, nil
}

// Resolve 只展开一层，不继承副项目自己的关联。已移除或离线的默认
// 关联不授予权限；显式请求的无效项目报错。
func (s *Service) Resolve(hash string, requested []string) ([]Project, error) {
	if hash == chatWorkspace {
		return []Project{}, nil
	}
	if !validHash(hash) {
		return nil, fmt.Errorf("项目不存在")
	}
	meta, err := s.metadata(hash)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("读取项目关联失败: %w", err)
	}
	projects := []Project{}
	seen := map[string]bool{hash: true}
	roots := []string{}
	if path, _ := meta["path"].(string); path != "" {
		if primary, err := directory(path); err == nil {
			roots = append(roots, primary.Path)
		}
	}
	appendResolved := func(project Project) error {
		if containsDirectory(roots, project.Path) {
			return nil
		}
		roots = append(roots, project.Path)
		projects = append(projects, project)
		if len(projects) > MaxProjects {
			return fmt.Errorf("默认与临时关联合计最多 %d 个副项目", MaxProjects)
		}
		return nil
	}
	appendProject := func(value string, required bool) error {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return nil
		}
		project, err := s.registered(value)
		if err != nil {
			if required {
				return err
			}
			return nil
		}
		seen[value] = true
		return appendResolved(project)
	}
	for _, value := range Hashes(meta) {
		if err := appendProject(value, false); err != nil {
			return nil, err
		}
	}
	for _, path := range Paths(meta) {
		project, err := directory(path)
		if err != nil {
			continue // 离线的长期关联不授予本轮权限，保留元数据供用户解除。
		}
		if err := appendResolved(project); err != nil {
			return nil, err
		}
	}
	for _, value := range requested {
		if err := appendProject(value, true); err != nil {
			return nil, err
		}
	}
	return projects, nil
}

// 未提供的列表保留原值，兼容只更新项目标识的旧客户端。
func (s *Service) Save(hash string, requestedHashes, requestedPaths []string) error {
	if !validHash(hash) {
		return fmt.Errorf("项目不存在")
	}
	s.files.Lock()
	defer s.files.Unlock()
	file := filepath.Join(s.home, "workspace", hash, "workspace.json")
	meta, err := s.metadata(hash)
	if err != nil {
		return fmt.Errorf("读取项目元数据失败: %w", err)
	}
	path, _ := meta["path"].(string)
	if path == "" {
		return fmt.Errorf("项目不存在")
	}
	primary, err := directory(path)
	if err != nil {
		return err
	}
	if requestedHashes == nil {
		requestedHashes = Hashes(meta)
	}
	if requestedPaths == nil {
		requestedPaths = Paths(meta)
	}
	hashes := []string{}
	paths := []string{}
	roots := []string{primary.Path}
	seen := map[string]bool{hash: true}
	for _, value := range requestedHashes {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		project, err := s.registered(value)
		if err != nil {
			return err
		}
		seen[value] = true
		if containsDirectory(roots, project.Path) {
			continue
		}
		roots = append(roots, project.Path)
		hashes = append(hashes, value)
	}
	for _, path := range requestedPaths {
		project, err := directory(path)
		if err != nil {
			return err
		}
		if sameDirectory(primary.Path, project.Path) {
			return fmt.Errorf("不能将当前项目关联为副项目")
		}
		if containsDirectory(roots, project.Path) {
			continue
		}
		roots = append(roots, project.Path)
		paths = append(paths, project.Path)
	}
	if len(hashes)+len(paths) > MaxProjects {
		return fmt.Errorf("最多关联 %d 个副项目", MaxProjects)
	}
	meta["linkedProjectHashes"] = hashes
	meta["linkedProjectPaths"] = paths
	if err := repository.WriteJSON(file, meta); err != nil {
		return fmt.Errorf("%w: %w", ErrStorage, err)
	}
	return nil
}

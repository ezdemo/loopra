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
	var hashes []string
	switch values := meta["linkedProjectHashes"].(type) {
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
	info, err := os.Stat(path)
	if !filepath.IsAbs(path) || err != nil || !info.IsDir() {
		return Project{}, fmt.Errorf("关联项目不存在或目录不可用: %s", hash)
	}
	name, _ := meta["displayName"].(string)
	if name == "" {
		name = filepath.Base(path)
	}
	return Project{Hash: hash, Name: name, Path: path}, nil
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
		projects = append(projects, project)
		if len(projects) > MaxProjects {
			return fmt.Errorf("默认与临时关联合计最多 %d 个副项目", MaxProjects)
		}
		return nil
	}
	for _, value := range Hashes(meta) {
		if err := appendProject(value, false); err != nil {
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

func (s *Service) Save(hash string, requested []string) error {
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
	hashes := []string{}
	seen := map[string]bool{hash: true}
	for _, value := range requested {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		if _, err := s.registered(value); err != nil {
			return err
		}
		seen[value] = true
		hashes = append(hashes, value)
	}
	if len(hashes) > MaxProjects {
		return fmt.Errorf("最多关联 %d 个副项目", MaxProjects)
	}
	meta["linkedProjectHashes"] = hashes
	if err := repository.WriteJSON(file, meta); err != nil {
		return fmt.Errorf("%w: %w", ErrStorage, err)
	}
	return nil
}

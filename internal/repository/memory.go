package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ezdemo/looprax/internal/model"
)

// MemoryRepository 的实例由应用共享，所有作用域的读改写都经过同一同步边界。
type MemoryRepository struct {
	home string
	mu   sync.Mutex
}

func NewMemoryRepository(home string) *MemoryRepository { return &MemoryRepository{home: home} }

func (r *MemoryRepository) path(project string) (string, error) {
	if project == "" {
		return filepath.Join(r.home, "memories.json"), nil
	}
	if project == "." || project == ".." || strings.ContainsAny(project, `/\:`) || filepath.Base(project) != project {
		return "", fmt.Errorf("invalid memory project")
	}
	data, err := os.ReadFile(filepath.Join(r.home, "workspace", project, "workspace.json"))
	if err != nil {
		return "", fmt.Errorf("read memory workspace: %w", err)
	}
	var workspace struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(data, &workspace); err != nil {
		return "", fmt.Errorf("decode memory workspace: %w", err)
	}
	if !filepath.IsAbs(workspace.Path) {
		return "", fmt.Errorf("memory workspace path must be absolute")
	}
	info, err := os.Stat(workspace.Path)
	if err != nil {
		return "", fmt.Errorf("stat memory workspace: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("memory workspace is not a directory")
	}
	return filepath.Join(workspace.Path, ".loopra", "memory", "memories.json"), nil
}

func readMemoryFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, (8<<20)+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	if len(data) > 8<<20 {
		return nil, fmt.Errorf("memory file is too large")
	}
	return data, nil
}

func (r *MemoryRepository) load(project string) ([]model.Memory, map[string]json.RawMessage, error) {
	path, err := r.path(project)
	if err != nil {
		return nil, nil, err
	}
	data, err := readMemoryFile(path)
	migrate := false
	if errors.Is(err, os.ErrNotExist) && project != "" {
		data, err = readMemoryFile(filepath.Join(r.home, "workspace", project, "memories.json"))
		migrate = err == nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return []model.Memory{}, map[string]json.RawMessage{"version": json.RawMessage(`1`)}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, nil, fmt.Errorf("decode memories: %w", err)
	}
	var version int
	if err := json.Unmarshal(doc["version"], &version); err != nil || version != 1 {
		return nil, nil, fmt.Errorf("unsupported memory file version")
	}
	var entries []model.Memory
	if err := json.Unmarshal(doc["entries"], &entries); err != nil || entries == nil {
		return nil, nil, fmt.Errorf("invalid memory entries")
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.ID == "" || seen[entry.ID] || entry.Revision < 1 || strings.TrimSpace(entry.Title) == "" || strings.TrimSpace(entry.Content) == "" {
			return nil, nil, fmt.Errorf("invalid memory entry")
		}
		seen[entry.ID] = true
	}
	if migrate {
		// 校验完成后才迁移，旧文件保留作备份；新位置已有数据时始终以新文件为准。
		if err := WriteFile(path, data); err != nil {
			return nil, nil, fmt.Errorf("migrate project memories: %w", err)
		}
	}
	return entries, doc, nil
}

func (r *MemoryRepository) List(project string) ([]model.Memory, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries, _, err := r.load(project)
	return entries, err
}

func (r *MemoryRepository) Update(project string, change func([]model.Memory) ([]model.Memory, error)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries, doc, err := r.load(project)
	if err != nil {
		return err
	}
	entries, err = change(entries)
	if err != nil {
		return err
	}
	// 保留文件未来添加的顶层字段。
	doc["entries"], err = json.Marshal(entries)
	if err != nil {
		return err
	}
	path, err := r.path(project)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if len(data)+1 > 8<<20 {
		return fmt.Errorf("memory file is too large")
	}
	return WriteFile(path, append(data, '\n'))
}

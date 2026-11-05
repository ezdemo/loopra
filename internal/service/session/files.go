// Package session 读写一个工作区的会话文件：日志、审计镜像和 .meta。
// 当前会话、标题和运行中的轮次仍由 HTTP 层持有。
package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/repository"
)

// Store 指向 <home>/workspace/<app>/sessions。
type Store struct {
	dir string
}

func Open(home, app string) *Store {
	return &Store{dir: filepath.Join(home, "workspace", app, "sessions")}
}

func (s *Store) Dir() string { return s.dir }

func (s *Store) LogPath(name string) string {
	return filepath.Join(s.dir, jsonl.SanitizeName(name)+".jsonl")
}

func (s *Store) EventsPath(name string) string {
	return filepath.Join(s.dir, jsonl.SanitizeName(name)+".events")
}

func (s *Store) MetaPath(name string) string {
	return filepath.Join(s.dir, jsonl.SanitizeName(name)+".meta")
}

// Persisted 判断会话是否已经真正落盘。可见日志有内容，或审计镜像有内容
// （回滚会把可见日志截断为空，但 .events 从不重写）都算。
func (s *Store) Persisted(name string) bool {
	return fileHasContent(s.LogPath(name)) || fileHasContent(s.EventsPath(name))
}

// HasHistory 在重建空白远端会话前检查日志与审计记录。
// 回滚、隐藏消息或损坏行都不能被当成从未发送过消息；检查失败也不能按空白处理。
func (s *Store) HasHistory(name string) (bool, error) {
	for _, path := range []string{s.LogPath(name), s.EventsPath(name)} {
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, fmt.Errorf("检查会话历史失败: %w", err)
		}
		if !info.Mode().IsRegular() {
			return false, fmt.Errorf("会话历史不是普通文件: %s", path)
		}
		if info.Size() > 0 {
			return true, nil
		}
	}
	return false, nil
}

func (s *Store) ReadMeta(name string) map[string]any {
	meta := map[string]any{}
	if data, err := os.ReadFile(s.MetaPath(name)); err == nil {
		_ = json.Unmarshal(data, &meta)
	}
	return meta
}

func (s *Store) WriteMeta(name string, meta map[string]any) error {
	return repository.WriteJSON(s.MetaPath(name), meta)
}

// Messages 以 {role, content} 行的形式读取会话历史，并去掉 adk_ 前缀字段。
func (s *Store) Messages(name string) []map[string]any {
	raw, _ := os.ReadFile(s.LogPath(name))
	out := []map[string]any{}
	for _, row := range decodeJSONLines(raw) {
		if row["web_hidden"] == true {
			continue
		}
		if row["role"] == nil {
			continue
		}
		for key := range row {
			if strings.HasPrefix(key, "adk_") {
				delete(row, key)
			}
		}
		out = append(out, row)
	}
	return out
}

func fileHasContent(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Size() > 0
}

func decodeJSONLines(data []byte) []map[string]any {
	out := []map[string]any{}
	for _, line := range strings.Split(string(data), "\n") {
		var row map[string]any
		if json.Unmarshal([]byte(line), &row) == nil && row != nil {
			out = append(out, row)
		}
	}
	return out
}

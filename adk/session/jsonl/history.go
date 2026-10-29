package jsonl

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"google.golang.org/adk/v2/session"
)

type snapshotKey struct{}

func WithSnapshot(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, snapshotKey{}, id)
}

func (s *Service) addDailyUsage(event *session.Event) error {
	u := event.UsageMetadata
	if u == nil {
		return nil
	}
	if u.PromptTokenCount+u.CandidatesTokenCount == 0 {
		return nil
	}
	path := filepath.Join(s.root, "usage_daily.jsonl")
	s.dailyMu.Lock()
	defer s.dailyMu.Unlock()
	return appendLines(path, []map[string]any{{"ts": event.Timestamp.UnixMilli(), "model": event.ModelVersion, "prompt": u.PromptTokenCount, "completion": u.CandidatesTokenCount, "cacheHit": u.CachedContentTokenCount, "cacheMiss": u.PromptTokenCount - u.CachedContentTokenCount}})
}

// Truncate 只重写可见日志。仅追加的 .events 审计日志
// 会被刻意保留，包括已从会话中移除的记录。
func (s *Service) Truncate(ctx context.Context, app, user, id, snapshot string, timestamp int64) (string, error) {
	path := s.jsonlPath(app, id)
	unlock := s.locks.lock(path)
	defer unlock()
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var kept bytes.Buffer
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 4096), 16<<20)
	found := false
	text := ""
	for scanner.Scan() {
		line := scanner.Bytes()
		var row map[string]any
		if json.Unmarshal(line, &row) == nil {
			match := snapshot != "" && (row["rollback_id"] == snapshot || row["snapshot_id"] == snapshot)
			if snapshot == "" && timestamp > 0 {
				if ts, ok := row["timestamp"].(float64); ok && int64(ts) >= timestamp {
					match = true
				}
			}
			if match && !found {
				found = true
				text, _ = row["content"].(string)
			}
		}
		if !found {
			kept.Write(line)
			kept.WriteByte('\n')
		}
	}
	if err = scanner.Err(); err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("未找到消息快照")
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".history-*.tmp")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(kept.Bytes()); err != nil {
		tmp.Close()
		return "", err
	}
	if err = tmp.Close(); err != nil {
		return "", err
	}
	if err = os.Rename(name, path); err != nil {
		return "", err
	}
	s.mu.Lock()
	delete(s.states, key(app, user, id))
	s.mu.Unlock()
	return text, nil
}

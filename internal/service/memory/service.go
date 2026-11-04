// Package memory 管理全局与项目长期记忆，不依赖会话历史或模型供应商。
package memory

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/repository"
)

var (
	ErrInvalid  = errors.New("记忆参数不正确")
	ErrNotFound = errors.New("记忆不存在")
	ErrConflict = errors.New("记忆已被更新，请重新加载后再操作")
)

type Service struct{ repository *repository.MemoryRepository }

func NewService(repository *repository.MemoryRepository) *Service {
	return &Service{repository: repository}
}

func (s *Service) List(project, query string) ([]model.Memory, error) {
	entries, err := s.repository.List(project)
	if err != nil {
		return nil, fmt.Errorf("读取记忆失败: %w", err)
	}
	out := make([]model.Memory, 0, len(entries))
	for _, entry := range entries {
		text := strings.ToLower(entry.Title + " " + entry.Content + " " + entry.Kind)
		match := true
		for _, word := range strings.Fields(strings.ToLower(query)) {
			if !strings.Contains(text, word) {
				match = false
				break
			}
		}
		if match {
			out = append(out, entry)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

func (s *Service) Read(project, id string) (model.Memory, error) {
	if id == "" {
		return model.Memory{}, ErrInvalid
	}
	entries, err := s.List(project, "")
	if err != nil {
		return model.Memory{}, err
	}
	for _, entry := range entries {
		if entry.ID == id {
			return entry, nil
		}
	}
	return model.Memory{}, ErrNotFound
}

func (s *Service) Save(project string, in model.Memory, source string) (model.Memory, error) {
	in.Title, in.Content = strings.TrimSpace(in.Title), strings.TrimSpace(in.Content)
	if !utf8.ValidString(in.Title) || !utf8.ValidString(in.Content) || utf8.RuneCountInString(in.Title) < 1 || utf8.RuneCountInString(in.Title) > 120 || utf8.RuneCountInString(in.Content) < 1 || utf8.RuneCountInString(in.Content) > 4000 {
		return model.Memory{}, fmt.Errorf("%w: 标题需为 1–120 字，内容需为 1–4000 字", ErrInvalid)
	}
	if in.Kind != "fact" && in.Kind != "preference" && in.Kind != "environment" {
		return model.Memory{}, fmt.Errorf("%w: 类型必须为 fact、preference 或 environment", ErrInvalid)
	}
	if source != "user" && source != "agent" {
		return model.Memory{}, ErrInvalid
	}
	var saved model.Memory
	err := s.repository.Update(project, func(entries []model.Memory) ([]model.Memory, error) {
		index := -1
		for i, entry := range entries {
			if entry.ID == in.ID {
				index = i
			}
			if strings.EqualFold(entry.Title, in.Title) && entry.ID != in.ID {
				return nil, fmt.Errorf("%w: 已有同名记忆，请检索后更新原条目", ErrConflict)
			}
		}
		now := time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
		if in.ID == "" {
			if in.Revision != 0 {
				return nil, ErrInvalid
			}
			if len(entries) >= 500 {
				return nil, fmt.Errorf("%w: 每个作用域最多保存 500 条记忆", ErrInvalid)
			}
			var id [16]byte
			if _, err := rand.Read(id[:]); err != nil {
				return nil, err
			}
			in.ID, in.Revision, in.CreatedAt = hex.EncodeToString(id[:]), 1, now
		} else {
			if index < 0 {
				return nil, ErrNotFound
			}
			if in.Revision != entries[index].Revision {
				return nil, ErrConflict
			}
			in.Revision++
			in.CreatedAt = entries[index].CreatedAt
		}
		in.Source, in.UpdatedAt = source, now
		if index < 0 {
			entries = append(entries, in)
		} else {
			entries[index] = in
		}
		saved = in
		return entries, nil
	})
	if err != nil {
		return model.Memory{}, err
	}
	return saved, nil
}

func (s *Service) Delete(project, id string, revision int64) error {
	if id == "" || revision < 1 {
		return ErrInvalid
	}
	return s.repository.Update(project, func(entries []model.Memory) ([]model.Memory, error) {
		for i, entry := range entries {
			if entry.ID == id {
				if entry.Revision != revision {
					return nil, ErrConflict
				}
				return append(entries[:i], entries[i+1:]...), nil
			}
		}
		return nil, ErrNotFound
	})
}

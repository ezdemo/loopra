package service

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/model"
)

var ErrWorkspaceRoot = errors.New("无法删除项目根目录")

type FileService struct{}

func NewFileService() *FileService { return &FileService{} }

func (s *FileService) Tree(root, relative string) ([]model.FileEntry, error) {
	dir, err := fsutil.SafeJoin(root, relative)
	if err != nil {
		return nil, fsutil.ErrInvalidPath
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
	out := []model.FileEntry{}
	for _, entry := range entries {
		rel := filepath.Join(relative, entry.Name())
		if _, err := fsutil.SafeJoin(root, rel); err != nil {
			continue
		}
		out = append(out, model.FileEntry{Name: entry.Name(), Path: filepath.ToSlash(rel), Directory: entry.IsDir()})
		if len(out) >= 200 {
			break
		}
	}
	return out, nil
}

func (s *FileService) Search(root, query string) []model.FileEntry {
	query = strings.ToLower(strings.TrimSpace(query))
	hits := []model.FileEntry{}
	filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if entry.IsDir() {
			if path != root && (slices.Contains([]string{".git", "node_modules", "target", "dist", "build", ".idea"}, entry.Name()) || len(strings.Split(rel, string(filepath.Separator))) >= 16) {
				return filepath.SkipDir
			}
			return nil
		}
		if len(hits) >= 100 {
			return filepath.SkipAll
		}
		if info, err := entry.Info(); err != nil || !info.Mode().IsRegular() {
			return nil
		}
		if _, err := fsutil.SafeJoin(root, rel); err != nil {
			return nil
		}
		if strings.Contains(strings.ToLower(filepath.ToSlash(rel)), query) {
			hits = append(hits, model.FileEntry{Name: entry.Name(), Path: filepath.ToSlash(rel)})
		}
		return nil
	})
	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		as, bs := strings.HasPrefix(strings.ToLower(a.Name), query), strings.HasPrefix(strings.ToLower(b.Name), query)
		if as != bs {
			return as
		}
		return strings.ToLower(a.Path) < strings.ToLower(b.Path)
	})
	return hits
}

func (s *FileService) Delete(root, relative string) error {
	abs, err := fsutil.SafeJoin(root, relative)
	if err != nil {
		return fsutil.ErrInvalidPath
	}
	if gitops.SamePath(abs, root) {
		return ErrWorkspaceRoot
	}
	return os.RemoveAll(abs)
}

func (s *FileService) Image(root, path string) ([]byte, string, error) {
	abs := path
	if !filepath.IsAbs(path) {
		var err error
		abs, err = fsutil.SafeJoin(root, path)
		if err != nil {
			return nil, "", errors.New("Invalid path")
		}
	}
	file, err := os.Open(abs)
	if err != nil {
		return nil, "", errors.New("图片不存在或不可读取")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (5<<20)+1))
	if err != nil || len(data) > 5<<20 {
		return nil, "", errors.New("图片不存在或超过 5 MiB")
	}
	mime := http.DetectContentType(data)
	if !slices.Contains([]string{"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-ms-bmp", "image/avif"}, mime) {
		return nil, "", errors.New("不支持的图片格式")
	}
	return data, mime, nil
}

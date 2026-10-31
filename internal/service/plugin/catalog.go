package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ezdemo/looprax/internal/repository"
)

const DefaultSource = "https://github.com/ezdemo/loopra-plugins"

type CatalogEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version,omitempty"`
	Source      string `json:"source"`
}

// Sources persists repository subscriptions independently of installed plugins.
func (h *Host) Sources() ([]string, error) {
	h.op.Lock()
	defer h.op.Unlock()
	return h.readSources()
}

func (h *Host) readSources() ([]string, error) {
	if h.home == "" {
		return nil, errNoHome
	}
	data, err := os.ReadFile(filepath.Join(h.base(), "sources.json"))
	if os.IsNotExist(err) {
		return []string{DefaultSource}, nil
	}
	if err != nil {
		return nil, err
	}
	var sources []string
	if err := json.Unmarshal(data, &sources); err != nil {
		return nil, fmt.Errorf("读取插件源失败: %w", err)
	}
	if sources == nil {
		sources = []string{}
	}
	return sources, nil
}

func (h *Host) SetSource(raw string, remove bool) ([]string, error) {
	src, err := repositorySource(raw)
	if err != nil {
		return nil, err
	}
	canonical := githubSourceURL(src)
	h.op.Lock()
	defer h.op.Unlock()
	sources, err := h.readSources()
	if err != nil {
		return nil, err
	}
	next := make([]string, 0, len(sources)+1)
	found := false
	for _, source := range sources {
		if source == canonical {
			found = true
			if remove {
				continue
			}
		}
		next = append(next, source)
	}
	if !remove && !found {
		if len(next) >= 32 {
			return nil, fmt.Errorf("最多添加 32 个插件源")
		}
		next = append(next, canonical)
	}
	if err := repository.WriteJSON(filepath.Join(h.base(), "sources.json"), next); err != nil {
		return nil, err
	}
	return next, nil
}

func repositorySource(raw string) (origin, error) {
	src, err := parseSource(raw)
	if err != nil || src.Kind != "github" {
		return origin{}, fmt.Errorf("插件源需要是 GitHub 仓库地址，如 https://github.com/owner/repo")
	}
	return src, nil
}

// The query preserves subdirectories even when a branch name contains slashes.
func githubSourceURL(src origin) string {
	u := url.URL{Scheme: "https", Host: "github.com", Path: "/" + strings.ToLower(src.Owner) + "/" + strings.ToLower(src.Repo), Fragment: src.Ref}
	if src.Subdir != "" {
		u.RawQuery = url.Values{"path": {src.Subdir}}.Encode()
	}
	return u.String()
}

// Catalog inspects package manifests and entries without executing plugin code.
// It uses the same bounded archive extraction as installation.
func (h *Host) Catalog(ctx context.Context, raw string) ([]CatalogEntry, error) {
	src, err := repositorySource(raw)
	if err != nil {
		return nil, err
	}
	data, err := h.githubTar(ctx, src)
	if err != nil {
		return nil, fmt.Errorf("读取插件源失败，请检查仓库是否公开且已有提交: %w", err)
	}
	dir, err := os.MkdirTemp("", "loopra-catalog-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	if err := extractTarGz(data, dir); err != nil {
		return nil, err
	}
	root := filepath.Join(dir, filepath.FromSlash(src.Subdir))
	if !inside(dir, root) {
		return nil, fmt.Errorf("子目录非法")
	}
	entries := []CatalogEntry{}
	seen := map[string]bool{}
	err = filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if file != root && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules") {
			return filepath.SkipDir
		}
		info := readPkg(file)
		if info.Name == "" {
			return nil
		}
		if _, err := findEntry(file, ""); err != nil {
			return nil
		}
		id := pluginID(info.Name)
		if seen[id] {
			return fmt.Errorf("插件源中有重复的插件标识 %s，请使用不同的 package.json name", id)
		}
		seen[id] = true
		rel, err := filepath.Rel(dir, file)
		if err != nil {
			return err
		}
		item := src
		item.Subdir = filepath.ToSlash(rel)
		if item.Subdir == "." {
			item.Subdir = ""
		}
		entries = append(entries, CatalogEntry{ID: id, Name: info.Name, Description: info.Description, Version: info.Version, Source: githubSourceURL(item)})
		return filepath.SkipDir
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

func validGitSubdir(sub string) bool {
	return sub == "" || !strings.ContainsAny(sub, `\:`) && !strings.HasPrefix(sub, "/") && path.Clean(sub) == sub && sub != "." && sub != ".." && !strings.HasPrefix(sub, "../")
}

package git

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
)

const (
	defaultAuthorName  = "Loopra"
	defaultAuthorEmail = "loopra@local"
)

// Defaults 是仓库未写明时回退的作者与模型。
type Defaults struct {
	Model          string
	ModelChannelID string
}

// AuthorFile 是 .loopra/git-author.json 的内容。
type AuthorFile struct {
	AuthorName     string `json:"authorName"`
	AuthorEmail    string `json:"authorEmail"`
	Model          string `json:"model"`
	ModelChannelID string `json:"modelChannelId"`
}

// AuthorConfig 按作者文件、git config、Loopra 默认值的顺序合并。
func AuthorConfig(dir string, defaults Defaults) map[string]string {
	author := readAuthor(dir)
	name, email := author.AuthorName, author.AuthorEmail
	run := gitops.Runner{Dir: dir}
	if name == "" {
		if out, err := run.Line(gitops.TimeoutQuery, "config", "user.name"); err == nil {
			name = out
		}
	}
	if email == "" {
		if out, err := run.Line(gitops.TimeoutQuery, "config", "user.email"); err == nil {
			email = out
		}
	}
	if name == "" {
		name = defaultAuthorName
	}
	if email == "" {
		email = defaultAuthorEmail
	}
	cfg := map[string]string{"authorName": name, "authorEmail": email}
	if author.Model != "" {
		cfg["model"] = author.Model
	} else if defaults.Model != "" {
		cfg["model"] = defaults.Model
	}
	if author.ModelChannelID != "" {
		cfg["modelChannelId"] = author.ModelChannelID
	} else if defaults.ModelChannelID != "" {
		cfg["modelChannelId"] = defaults.ModelChannelID
	}
	return cfg
}

// SaveSelection 把作者与非空的模型选择写回作者文件。写入失败时保持原文件。
func SaveSelection(dir string, cfg map[string]string) {
	body := map[string]string{
		"authorName":  cfg["authorName"],
		"authorEmail": cfg["authorEmail"],
	}
	if model := strings.TrimSpace(cfg["model"]); model != "" {
		body["model"] = model
	}
	if channel := strings.TrimSpace(cfg["modelChannelId"]); channel != "" {
		body["modelChannelId"] = channel
	}
	path := filepath.Join(dir, ".loopra", "git-author.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0o644)
}

// SavePosted 按请求体原样写入作者文件，空的模型字段也会落盘。
func SavePosted(dir string, file AuthorFile) error {
	path := filepath.Join(dir, ".loopra", "git-author.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail(http.StatusInternalServerError, err.Error())
	}
	data, _ := json.MarshalIndent(file, "", "  ")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fail(http.StatusInternalServerError, err.Error())
	}
	return nil
}

func readAuthor(dir string) AuthorFile {
	var author AuthorFile
	if data, err := os.ReadFile(filepath.Join(dir, ".loopra", "git-author.json")); err == nil {
		_ = json.Unmarshal(data, &author)
	}
	return author
}

// StatusDTO 构造状态响应。wrapConfig 为真时并入模型配置。
func StatusDTO(dir string, view gitops.StatusView, wrapConfig bool, defaults Defaults) map[string]any {
	dto := map[string]any{
		"gitAvailable":  view.GitAvailable,
		"initialized":   view.Initialized,
		"changed":       view.Changed,
		"untracked":     view.Untracked,
		"ahead":         view.Ahead,
		"behind":        view.Behind,
		"workspacePath": dir,
	}
	if view.Branch != "" {
		dto["branch"] = view.Branch
	}
	if view.Upstream != "" {
		dto["upstream"] = view.Upstream
	}
	if wrapConfig && view.Initialized {
		cfg := AuthorConfig(dir, defaults)
		dto["model"] = cfg["model"]
		dto["modelChannelId"] = cfg["modelChannelId"]
	}
	return dto
}

package plugin

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// origin 是已经识别的插件来源。Kind 为 npm 或 github。
type origin struct {
	Kind    string
	Display string
	Name    string
	Version string
	Owner   string
	Repo    string
	Ref     string
	Subdir  string
}

var (
	npmPlain  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$`)
	npmScoped = regexp.MustCompile(`^@[A-Za-z0-9][A-Za-z0-9._-]{0,213}/[A-Za-z0-9][A-Za-z0-9._-]{0,213}$`)
	gitName   = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
)

func parseSource(raw string) (origin, error) {
	source := strings.TrimSpace(raw)
	if source == "" {
		return origin{}, fmt.Errorf("source 不能为空（npm 包名或 GitHub 地址）")
	}
	lower := strings.ToLower(source)
	if strings.HasSuffix(lower, ".jar") || strings.Contains(lower, ".jar?") || strings.Contains(lower, ".jar#") {
		return origin{}, fmt.Errorf("不再支持 JAR 插件，请填写 npm 包名或 GitHub 地址")
	}
	if strings.HasPrefix(lower, "file:") || strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") && !strings.Contains(lower, "github.com/") {
		return origin{}, fmt.Errorf("只接受 npm 包（如 left-pad 或 @scope/pkg@1.2.3）或 GitHub 地址（如 https://github.com/owner/repo）")
	}
	if strings.HasPrefix(lower, "npm:") || strings.HasPrefix(source, "@") || !strings.Contains(strings.TrimPrefix(source, "npm:"), "/") && !strings.Contains(source, "github.com") && !strings.HasPrefix(lower, "github:") {
		return parseNPM(source)
	}
	parsed, ok := parseGitHub(source)
	if !ok {
		return origin{}, fmt.Errorf("只接受 npm 包（如 left-pad 或 @scope/pkg@1.2.3）或 GitHub 地址（如 https://github.com/owner/repo）")
	}
	parsed.Display = source
	return parsed, nil
}

func parseNPM(raw string) (origin, error) {
	source := strings.TrimSpace(strings.TrimPrefix(raw, "npm:"))
	name := source
	version := "latest"
	if i := strings.LastIndex(source, "@"); i > 0 {
		name = source[:i]
		version = source[i+1:]
	}
	if !validNPMName(name) {
		return origin{}, fmt.Errorf("无效的 npm 包名")
	}
	version = strings.TrimSpace(version)
	if version == "" {
		version = "latest"
	}
	if strings.Contains(version, "://") || strings.Contains(version, "..") || strings.ContainsAny(version, `/\`) {
		return origin{}, fmt.Errorf("无效的 npm 版本")
	}
	return origin{Kind: "npm", Display: strings.TrimSpace(raw), Name: name, Version: version}, nil
}

func validNPMName(name string) bool {
	return npmPlain.MatchString(name) || npmScoped.MatchString(name)
}

func parseGitHub(raw string) (origin, bool) {
	source := strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(source), "http://") {
		return origin{}, false
	}
	if strings.HasPrefix(source, "github.com/") {
		source = "https://" + source
	}
	if strings.HasPrefix(source, "https://") {
		u, err := url.Parse(source)
		if err != nil || !strings.EqualFold(u.Hostname(), "github.com") {
			return origin{}, false
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) < 2 {
			return origin{}, false
		}
		owner, repo := parts[0], strings.TrimSuffix(parts[1], ".git")
		ref := u.Fragment
		sub := ""
		if len(parts) >= 4 && parts[2] == "tree" {
			ref = parts[3]
			if len(parts) > 4 {
				sub = strings.Join(parts[4:], "/")
			}
		} else if len(parts) > 2 {
			return origin{}, false
		}
		if !validGitName(owner) || !validGitName(repo) || strings.Contains(ref, "..") || strings.Contains(sub, "..") {
			return origin{}, false
		}
		return origin{Kind: "github", Owner: owner, Repo: repo, Ref: ref, Subdir: sub}, true
	}
	name := source
	if strings.HasPrefix(strings.ToLower(name), "github:") {
		name = name[len("github:"):]
	}
	name = strings.TrimSuffix(name, ".git")
	repoName, ref, _ := strings.Cut(name, "#")
	parts := strings.Split(repoName, "/")
	if len(parts) != 2 || strings.HasPrefix(parts[0], "@") {
		return origin{}, false
	}
	if !validGitName(parts[0]) || !validGitName(parts[1]) || strings.Contains(ref, "..") {
		return origin{}, false
	}
	return origin{Kind: "github", Owner: parts[0], Repo: parts[1], Ref: ref}, true
}

func validGitName(name string) bool {
	return gitName.MatchString(name) && name != "." && name != ".."
}

func pluginID(name string) string {
	name = strings.TrimSpace(name)
	name = strings.TrimPrefix(name, "@")
	name = strings.ReplaceAll(name, "/", "__")
	return ident(name)
}

func ident(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	for strings.Contains(out, "__") {
		out = strings.ReplaceAll(out, "__", "_")
	}
	if out == "" {
		return "plugin"
	}
	if out[0] >= '0' && out[0] <= '9' {
		out = "p_" + out
	}
	if len(out) > 48 {
		out = strings.Trim(out[:48], "_")
	}
	return out
}

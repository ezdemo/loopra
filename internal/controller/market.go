package controller

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/repository"
)

var skillSlug = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

func safeSlug(slug string) bool { return skillSlug.MatchString(slug) && slug != "." && slug != ".." }

func marketBase(name string) string {
	if name == "clawhub.ai" {
		if base := os.Getenv("LOOPRA_CLAWHUB_URL"); base != "" {
			return strings.TrimRight(base, "/")
		}
		return "https://clawhub.ai"
	}
	if base := os.Getenv("LOOPRA_SKILLHUB_URL"); base != "" {
		return strings.TrimRight(base, "/")
	}
	return "https://api.skillhub.cn"
}

func fetchBytes(r *http.Request, target string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Loopra/1.0")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("下载文件超过大小限制")
	}
	return raw, nil
}

func fetchMarket(r *http.Request, target string) (map[string]any, error) {
	raw, err := fetchBytes(r, target, 16<<20)
	if err != nil {
		return nil, err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	if data["error"] != nil {
		return nil, fmt.Errorf("市场请求失败: %v", data["message"])
	}
	return data, nil
}

func marketItem(node map[string]any, market string, detail bool, root map[string]any) map[string]any {
	first := func(keys ...string) any {
		for _, key := range keys {
			if v, ok := node[key].(string); ok && v != "" {
				return v
			}
		}
		return ""
	}
	out := map[string]any{"slug": node["slug"], "name": node["slug"], "displayName": node["displayName"], "summary": first("summary"), "description": first("description_zh", "description"), "ownerHandle": first("owner_name", "ownerHandle"), "url": node["url"], "installs": int64(0), "stars": int64(0)}
	if out["url"] == nil {
		out["url"] = "https://" + market + "/skills/" + fmt.Sprint(node["slug"])
	}
	if detail {
		out["installSlug"] = node["slug"]
	}
	if market == "skillhub.cn" {
		if detail {
			out["summary"] = first("summary_zh", "summary")
			out["description"] = out["summary"]
			if owner, ok := root["owner"].(map[string]any); ok {
				out["ownerHandle"] = owner["handle"]
			}
		}
		out["installs"], out["stars"] = number(node["installs"]), number(node["stars"])
	}
	if stats, ok := node["stats"].(map[string]any); ok {
		key := "installs"
		if market == "clawhub.ai" {
			key = "installsCurrent"
		}
		out["installs"], out["stars"] = number(stats[key]), number(stats["stars"])
	}
	return out
}

func extractSkill(raw []byte, target string) error {
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return err
	}
	var total uint64
	for _, file := range reader.File {
		if strings.Contains(file.Name, "\\") || strings.Contains(file.Name, ":") || file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("技能包包含无效路径")
		}
		path := filepath.Join(target, filepath.FromSlash(file.Name))
		rel, err := filepath.Rel(target, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("技能包路径越界")
		}
		total += file.UncompressedSize64
		if total > 128<<20 {
			return fmt.Errorf("解压内容超过大小限制")
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
			continue
		}
		src, err := file.Open()
		if err != nil {
			return err
		}
		content, readErr := io.ReadAll(io.LimitReader(src, (16<<20)+1))
		src.Close()
		if readErr != nil {
			return readErr
		}
		if len(content) > 16<<20 {
			return fmt.Errorf("技能文件超过大小限制")
		}
		if err := repository.WriteFile(path, content); err != nil {
			return err
		}
	}
	return nil
}

func (s *Controller) marketController(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/skill-market/")
	if action == "markets" {
		writeOK(w, http.StatusOK, []map[string]any{{"name": "skillhub.cn", "description": "专为中国用户优化的技能社区"}, {"name": "clawhub.ai", "description": "ClawHub 国际技能市场"}})
		return
	}
	q := r.URL.Query()
	if r.Method == http.MethodPost && strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		for key, value := range body {
			q.Set(key, value)
		}
	} else if r.Method == http.MethodPost {
		_ = r.ParseForm()
		for key, values := range r.PostForm {
			for _, value := range values {
				q.Add(key, value)
			}
		}
	}
	market := q.Get("marketName")
	if market != "clawhub.ai" {
		market = "skillhub.cn"
	}
	base := marketBase(market)
	slug := q.Get("slug")
	fail := func(err error) { writeFail(w, http.StatusBadRequest, err.Error()) }
	if action == "uninstall" {
		if strings.HasPrefix(q.Get("scope"), "builtin") || strings.HasPrefix(slug, "builtin") {
			writeFail(w, http.StatusOK, "内置技能不可卸载")
			return
		}
		if !safeSlug(slug) {
			writeFail(w, http.StatusOK, "Invalid slug")
			return
		}
		target := filepath.Join(s.home, "skills", slug)
		if info, err := os.Lstat(target); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			writeFail(w, http.StatusOK, "技能未找到: "+slug)
			return
		}
		if err := os.RemoveAll(target); err != nil {
			fail(err)
			return
		}
		writeOK(w, http.StatusOK, nil)
		return
	}
	if action == "detail" || action == "install" {
		if !safeSlug(slug) {
			writeFail(w, http.StatusOK, "Invalid slug")
			return
		}
		data, err := fetchMarket(r, base+"/api/v1/skills/"+url.PathEscape(slug))
		if err != nil {
			fail(err)
			return
		}
		node, ok := data["skill"].(map[string]any)
		if !ok {
			fail(fmt.Errorf("技能不存在: %s", slug))
			return
		}
		detail := marketItem(node, market, true, data)
		if action == "detail" {
			writeOK(w, http.StatusOK, detail)
			return
		}
		raw, err := fetchBytes(r, base+"/api/v1/download?slug="+url.QueryEscape(slug), 32<<20)
		if err != nil {
			fail(err)
			return
		}
		root := filepath.Join(s.home, "skills")
		if err := os.MkdirAll(root, 0o755); err != nil {
			fail(err)
			return
		}
		stage, err := os.MkdirTemp(root, ".install-")
		if err != nil {
			fail(err)
			return
		}
		defer os.RemoveAll(stage)
		if err := extractSkill(raw, stage); err != nil {
			fail(err)
			return
		}
		target := filepath.Join(root, slug)
		backup := target + ".previous-" + newMsgID()
		s.state.files.Lock()
		hadOld := false
		if _, err := os.Lstat(target); err == nil {
			if err := os.Rename(target, backup); err != nil {
				s.state.files.Unlock()
				fail(err)
				return
			}
			hadOld = true
		}
		if err := os.Rename(stage, target); err != nil {
			if hadOld {
				_ = os.Rename(backup, target)
			}
			s.state.files.Unlock()
			fail(err)
			return
		}
		if hadOld {
			_ = os.RemoveAll(backup)
		}
		s.state.files.Unlock()
		display, _ := detail["displayName"].(string)
		if display == "" {
			display = slug
		}
		writeOK(w, http.StatusOK, display)
		return
	}
	if action != "proxy" {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := q.Get("q")
	target := base + "/api/v1/search?q=" + url.QueryEscape(query) + "&limit=" + strconv.Itoa(limit)
	if market == "clawhub.ai" && q.Get("action") != "search" {
		target = base + "/api/v1/skills?limit=" + strconv.Itoa(limit) + "&sort=trending"
	}
	data, err := fetchMarket(r, target)
	if err != nil {
		fail(err)
		return
	}
	items, _ := data["results"].([]any)
	if items == nil {
		items, _ = data["items"].([]any)
	}
	out := []map[string]any{}
	for _, item := range items {
		if node, ok := item.(map[string]any); ok {
			out = append(out, marketItem(node, market, false, data))
		}
	}
	writeOK(w, http.StatusOK, out)
}

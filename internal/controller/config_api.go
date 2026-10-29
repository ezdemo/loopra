package controller

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
)

func (s *Controller) restoreMaskedKeys(patch map[string]any) {
	saved := s.configSnapshot()
	if key, ok := patch["apiKey"].(string); ok && strings.Contains(key, "****") {
		patch["apiKey"] = saved.APIKey
	}
	if proxy, ok := patch["proxyAddress"]; ok {
		patch["proxy"] = proxy
	}
	if channels, ok := patch["modelChannels"].([]any); ok {
		for i, entry := range channels {
			ch, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			id, _ := ch["id"].(string)
			if id == "" {
				id = fmt.Sprintf("channel-%d", i+1)
				ch["id"] = id
			}
			if key, ok := ch["apiKey"].(string); ok && strings.Contains(key, "****") {
				if old, found := saved.ChannelByID(id); found {
					ch["apiKey"] = old.APIKey
				}
			}
		}
	}
	// 遗留的顶层 API 设置用于描述当前选中的渠道。
	if _, channelsChanged := patch["modelChannels"]; !channelsChanged {
		for i, ch := range saved.ModelChannels {
			if ch.ID != saved.ModelChannelID {
				continue
			}
			changed := false
			for _, field := range []string{"apiKey", "baseUrl", "apiProtocol"} {
				if value, ok := patch[field].(string); ok {
					switch field {
					case "apiKey":
						saved.ModelChannels[i].APIKey = value
					case "baseUrl":
						saved.ModelChannels[i].BaseURL = value
					case "apiProtocol":
						saved.ModelChannels[i].APIProtocol = value
					}
					changed = true
				}
			}
			if changed {
				patch["modelChannels"] = saved.ModelChannels
			}
		}
	}
}

func (s *Controller) modelsController(w http.ResponseWriter, r *http.Request) {
	cfg := s.configSnapshot()
	out := []map[string]any{}
	for _, ch := range cfg.ModelChannels {
		models := append([]config.ModelEntry(nil), ch.Models...)
		if ch.ID == cfg.ModelChannelID {
			found := false
			for _, m := range models {
				found = found || m.Name == cfg.Model
			}
			if !found {
				models = append(models, config.ModelEntry{Name: cfg.Model})
			}
		}
		seen := map[string]bool{}
		for _, m := range models {
			if seen[m.Name] {
				continue
			}
			seen[m.Name] = true
			out = append(out, map[string]any{"name": m.Name, "active": ch.ID == cfg.ModelChannelID && m.Name == cfg.Model, "channelId": ch.ID, "channelName": ch.Name, "displayName": m.DisplayName})
		}
	}
	writeOK(w, http.StatusOK, map[string]any{"current": cfg.Model, "currentChannelId": cfg.ModelChannelID, "models": out})
}

func (s *Controller) remoteModelsController(w http.ResponseWriter, r *http.Request) {
	cfg := s.configSnapshot()
	input := map[string]string{"channelId": r.URL.Query().Get("channelId")}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeFail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
	}
	ch, found := cfg.ChannelByID(input["channelId"])
	if !found && r.Method == http.MethodGet {
		writeFail(w, http.StatusOK, "模型渠道不存在")
		return
	}
	base, key := input["baseUrl"], input["apiKey"]
	if base == "" {
		base = ch.BaseURL
	}
	if key == "" || strings.Contains(key, "****") {
		key = ch.APIKey
	}
	if base == "" {
		writeFail(w, http.StatusOK, "API 地址未配置")
		return
	}
	if key == "" {
		writeFail(w, http.StatusOK, "API 密钥未配置")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, strings.TrimRight(base, "/")+"/models", nil)
	if err != nil {
		writeFail(w, http.StatusOK, err.Error())
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeFail(w, http.StatusOK, "获取远程模型列表失败: "+err.Error())
		return
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		writeFail(w, http.StatusOK, err.Error())
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeFail(w, http.StatusOK, fmt.Sprintf("远程 API 返回错误 (%d): %s", resp.StatusCode, raw))
		return
	}
	var data struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		writeFail(w, http.StatusOK, "获取远程模型列表失败: "+err.Error())
		return
	}
	names := []string{}
	for _, model := range data.Data {
		if model.ID != "" {
			names = append(names, model.ID)
		}
	}
	sort.Strings(names)
	writeOK(w, http.StatusOK, names)
}

func orderIndex(order []string, key string) int {
	for i, item := range order {
		if item == key {
			return i
		}
	}
	return len(order)
}

func (s *Controller) registerProject(hash, path string) error {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	file := filepath.Join(s.home, "workspace", hash, "workspace.json")
	meta := repository.ReadObject(file)
	meta["path"], meta["lastAccessedAt"] = path, time.Now().UnixMilli()
	if _, exists := meta["createdAt"]; !exists {
		meta["createdAt"] = time.Now().UnixMilli()
	}
	return repository.WriteJSON(file, meta)
}

func (s *Controller) projectList() []map[string]any {
	out := []map[string]any{}
	dirs, _ := os.ReadDir(filepath.Join(s.home, "workspace"))
	for _, dir := range dirs {
		if !dir.IsDir() || dir.Name() == "__loopra_chat__" {
			continue
		}
		base := filepath.Join(s.home, "workspace", dir.Name())
		info := repository.ReadObject(filepath.Join(base, "workspace.json"))
		path, _ := info["path"].(string)
		if path == "" {
			continue
		}
		name := filepath.Base(path)
		if display, _ := info["displayName"].(string); display != "" {
			name = display
		}
		sessions, _ := filepath.Glob(filepath.Join(base, "sessions", "*.jsonl"))
		info["hash"], info["name"], info["sessionCount"] = dir.Name(), name, len(sessions)
		out = append(out, info)
	}
	order := s.configSnapshot().WorkspaceOrder
	sort.SliceStable(out, func(i, j int) bool {
		a, b := orderIndex(order, out[i]["hash"].(string)), orderIndex(order, out[j]["hash"].(string))
		if a != b {
			return a < b
		}
		return number(out[i]["createdAt"]) < number(out[j]["createdAt"])
	})
	return out
}

func number(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}

func (s *Controller) workspaceController(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/workspace":
		if r.Method == http.MethodGet {
			writeOK(w, http.StatusOK, s.workspaceRoot())
			return
		}
		var body struct {
			Path string `json:"path"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Path == "" {
			writeFail(w, http.StatusBadRequest, "路径不能为空")
			return
		}
		path, err := filepath.Abs(body.Path)
		info, statErr := os.Stat(path)
		if err != nil || statErr != nil || !info.IsDir() {
			writeFail(w, http.StatusBadRequest, "无效的工作目录路径: "+body.Path)
			return
		}
		if err := s.registerProject(service.WorkspaceHash(path), path); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := s.saveConfig(map[string]any{"workspaceDir": path}); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{"message": "工作目录已切换", "workspace": path, "currentSession": nil})
	case r.URL.Path == "/api/workspaces":
		writeOK(w, http.StatusOK, s.projectList())
	case r.URL.Path == "/api/workspaces/order":
		if r.Method == http.MethodGet {
			writeOK(w, http.StatusOK, s.configSnapshot().WorkspaceOrder)
			return
		}
		var order []string
		if json.NewDecoder(r.Body).Decode(&order) != nil || order == nil {
			writeFail(w, http.StatusBadRequest, "排序数据不能为空")
			return
		}
		if err := s.saveConfig(map[string]any{"workspaceOrder": order}); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, "排序已保存")
	case r.Method == http.MethodPut:
		hash := r.PathValue("hash")
		path, err := s.resolveProject(hash)
		if err != nil {
			writeFail(w, http.StatusBadRequest, "项目不存在")
			return
		}
		var body map[string]*string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["displayName"] == nil {
			writeFail(w, http.StatusBadRequest, "缺少展示名称 displayName")
			return
		}
		name := strings.TrimSpace(*body["displayName"])
		if len(utf16.Encode([]rune(name))) > 100 {
			writeFail(w, http.StatusBadRequest, "展示名称不能超过 100 字符")
			return
		}
		s.state.files.Lock()
		file := filepath.Join(s.home, "workspace", hash, "workspace.json")
		meta := repository.ReadObject(file)
		meta["path"], meta["displayName"] = path, name
		err = repository.WriteJSON(file, meta)
		s.state.files.Unlock()
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, info := range s.projectList() {
			if info["hash"] == hash {
				writeOK(w, http.StatusOK, info)
				return
			}
		}
		writeFail(w, http.StatusBadRequest, "项目不存在")
	case r.Method == http.MethodDelete:
		hash := r.PathValue("hash")
		if _, err := s.resolveProject(hash); err != nil || filepath.Base(hash) != hash {
			writeFail(w, http.StatusBadRequest, "删除项目失败")
			return
		}
		if s.hasRunningProject(hash) {
			writeFail(w, http.StatusConflict, "项目有正在运行的会话")
			return
		}
		if err := os.RemoveAll(filepath.Join(s.home, "workspace", hash)); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.state.mu.Lock()
		delete(s.state.runtimes, hash)
		delete(s.state.current, hash)
		s.state.mu.Unlock()
		writeOK(w, http.StatusOK, "项目已删除")
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) loopraMDController(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.home, "loopra.md")
	if r.Method == http.MethodGet {
		data, _ := os.ReadFile(path)
		writeOK(w, http.StatusOK, string(data))
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	var text string
	if json.Unmarshal(data, &text) == nil {
		data = []byte(text)
	}
	if err = repository.WriteFile(path, data); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.state.mu.Lock()
	s.state.runtimes = map[string]*ProjectRuntime{}
	s.state.mu.Unlock()
	writeOK(w, http.StatusOK, "loopra.md 已保存，Agent 已重新初始化，新会话将使用更新后的提示词")
}

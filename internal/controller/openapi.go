package controller

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
)

type openapiSource struct {
	DocURL       string            `json:"docUrl"`
	Headers      map[string]string `json:"headers,omitempty"`
	AuthType     string            `json:"authType"`
	AuthConfig   map[string]string `json:"authConfig,omitempty"`
	Enabled      bool              `json:"enabled"`
	Status       string            `json:"status"`
	ErrorMessage string            `json:"errorMessage,omitempty"`
}

func (s *Controller) openapiSources() []openapiSource {
	out := []openapiSource{}
	raw, err := os.ReadFile(filepath.Join(s.home, "openapi-sources.json"))
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func (s *Controller) fetchOpenapi(r *http.Request, source openapiSource) ([]byte, error) {
	target, err := url.Parse(source.DocURL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, fmt.Errorf("仅支持 http(s) OpenAPI 文档地址")
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, source.DocURL, nil)
	if err != nil {
		return nil, err
	}
	for name, value := range source.Headers {
		req.Header.Set(name, value)
	}
	switch source.AuthType {
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+source.AuthConfig["token"])
	case "basic":
		req.SetBasicAuth(source.AuthConfig["username"], source.AuthConfig["password"])
	case "apikey":
		if name := source.AuthConfig["name"]; name != "" {
			req.Header.Set(name, source.AuthConfig["value"])
		}
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("文档服务器返回 HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 16<<20 {
		return nil, fmt.Errorf("OpenAPI 文档超过 16 MiB")
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		if err := yaml.Unmarshal(raw, &document); err != nil {
			return nil, fmt.Errorf("OpenAPI 文档无效: %w", err)
		}
	}
	if document["openapi"] == nil && document["swagger"] == nil {
		return nil, fmt.Errorf("文档缺少 openapi/swagger 版本")
	}
	if _, ok := document["paths"].(map[string]any); !ok {
		return nil, fmt.Errorf("文档缺少 paths")
	}
	return json.Marshal(document)
}

func (s *Controller) openapiCachePath(source string) string {
	return filepath.Join(s.home, "openapi", service.WorkspaceHash(source)+".json")
}

func (s *Controller) openapiManageController(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/openapi/")
	if action == "search" {
		keywords := strings.Fields(strings.ToLower(r.URL.Query().Get("keyword")))
		if len(keywords) == 0 {
			writeFail(w, http.StatusBadRequest, "keyword 不能为空")
			return
		}
		results := []map[string]any{}
		for _, source := range s.openapiSources() {
			if !source.Enabled || source.Status != "loaded" {
				continue
			}
			raw, err := os.ReadFile(s.openapiCachePath(source.DocURL))
			if err != nil {
				raw, err = s.fetchOpenapi(r, source)
				if err != nil {
					continue
				}
				_ = repository.WriteFile(s.openapiCachePath(source.DocURL), raw)
			}
			var doc map[string]any
			if json.Unmarshal(raw, &doc) != nil {
				continue
			}
			paths, _ := doc["paths"].(map[string]any)
			for path, value := range paths {
				item, _ := value.(map[string]any)
				for method, definition := range item {
					if !containsString([]string{"get", "post", "put", "patch", "delete", "head", "options", "trace"}, method) {
						continue
					}
					operation, ok := definition.(map[string]any)
					if !ok {
						continue
					}
					encoded, _ := json.Marshal(operation)
					haystack := strings.ToLower(path + " " + method + " " + string(encoded))
					match := true
					for _, keyword := range keywords {
						if !strings.Contains(haystack, keyword) {
							match = false
							break
						}
					}
					if match {
						name := operation["operationId"]
						if name == nil {
							name = operation["summary"]
						}
						if name == nil {
							name = strings.ToUpper(method) + " " + path
						}
						results = append(results, map[string]any{"api_name": name, "category": operation["tags"], "endpoint": strings.ToUpper(method) + " " + path, "docUrl": source.DocURL, "method": strings.ToUpper(method), "path": path, "summary": operation["summary"], "description": operation["description"], "operationId": operation["operationId"], "parameters": operation["parameters"], "requestBody": operation["requestBody"], "responses": operation["responses"]})
					}
				}
			}
		}
		writeOK(w, http.StatusOK, results)
		return
	}
	if action == "sources" && r.Method == http.MethodGet {
		writeOK(w, http.StatusOK, s.openapiSources())
		return
	}
	if action != "sources" && action != "sources/refresh" {
		writeFail(w, http.StatusNotFound, "未找到路径")
		return
	}
	var input openapiSource
	if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.DocURL) == "" {
		writeFail(w, http.StatusBadRequest, "docUrl 不能为空")
		return
	}
	if input.AuthType == "" {
		input.AuthType = "none"
	}
	if !containsString([]string{"none", "bearer", "apikey", "basic"}, input.AuthType) {
		writeFail(w, http.StatusBadRequest, "不支持的认证方式")
		return
	}
	if r.Method == http.MethodDelete {
		s.state.files.Lock()
		list := s.openapiSources()
		next := []openapiSource{}
		for _, entry := range list {
			if entry.DocURL != input.DocURL {
				next = append(next, entry)
			}
		}
		err := repository.WriteJSON(filepath.Join(s.home, "openapi-sources.json"), next)
		_ = os.Remove(s.openapiCachePath(input.DocURL))
		s.state.files.Unlock()
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, nil)
		return
	}
	raw, loadErr := s.fetchOpenapi(r, input)
	input.Enabled = true
	input.Status = "loaded"
	if loadErr != nil {
		input.Status = "error"
		input.ErrorMessage = loadErr.Error()
	} else if err := repository.WriteFile(s.openapiCachePath(input.DocURL), raw); err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.state.files.Lock()
	list := s.openapiSources()
	next := []openapiSource{}
	for _, entry := range list {
		if entry.DocURL != input.DocURL {
			next = append(next, entry)
		}
	}
	next = append(next, input)
	err := repository.WriteJSON(filepath.Join(s.home, "openapi-sources.json"), next)
	s.state.files.Unlock()
	if err != nil {
		writeFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if loadErr != nil {
		writeFail(w, http.StatusOK, "OpenAPI 源注册失败: "+loadErr.Error())
		return
	}
	writeOK(w, http.StatusOK, input)
}

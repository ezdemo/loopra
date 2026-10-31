package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	"go.yaml.in/yaml/v3"
)

type Source struct {
	Name         string            `json:"name,omitempty"`
	DocURL       string            `json:"docUrl"`
	BaseURL      string            `json:"baseUrl,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	AuthType     string            `json:"authType"`
	AuthConfig   map[string]string `json:"authConfig,omitempty"`
	Enabled      bool              `json:"enabled"`
	Status       string            `json:"status"`
	ErrorMessage string            `json:"errorMessage,omitempty"`
}

type Service struct {
	Home string
	mu   sync.Mutex
}

func New(home string) *Service         { return &Service{Home: home} }
func (s *Service) sourcesPath() string { return filepath.Join(s.Home, "openapi-sources.json") }
func (s *Service) cachePath(docURL string) string {
	return filepath.Join(s.Home, "openapi", service.WorkspaceHash(docURL)+".json")
}
func (s *Service) list() ([]Source, error) {
	list := []Source{}
	raw, err := os.ReadFile(s.sourcesPath())
	if os.IsNotExist(err) {
		return list, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	if list == nil {
		list = []Source{}
	}
	return list, nil
}
func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}
func text(v any) string { str, _ := v.(string); return str }
func httpURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errors.New("仅支持不含用户信息的 http(s) 地址")
	}
	return u, nil
}
func authorize(req *http.Request, source Source) {
	for name, value := range source.Headers {
		req.Header.Set(name, value)
	}
	switch strings.ToLower(source.AuthType) {
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+source.AuthConfig["token"])
	case "basic":
		req.SetBasicAuth(source.AuthConfig["username"], source.AuthConfig["password"])
	case "apikey":
		if name := source.AuthConfig["name"]; name != "" {
			if source.AuthConfig["in"] == "query" {
				q := req.URL.Query()
				q.Set(name, source.AuthConfig["value"])
				req.URL.RawQuery = q.Encode()
			} else {
				req.Header.Set(name, source.AuthConfig["value"])
			}
		}
	}
}
func client() *http.Client {
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		// A redirect must not forward configured credentials to another host.
		if len(via) >= 5 {
			return errors.New("重定向次数过多")
		}
		if req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host {
			return errors.New("不允许跨源重定向")
		}
		return nil
	}}
}
func readLimited(r io.Reader, limit int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("响应超过 %d 字节", limit)
	}
	return raw, nil
}
func (s *Service) fetch(ctx context.Context, source Source) (map[string]any, error) {
	if _, err := httpURL(source.DocURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.DocURL, nil)
	if err != nil {
		return nil, err
	}
	authorize(req, source)
	resp, err := client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("文档服务器返回 HTTP %d", resp.StatusCode)
	}
	raw, err := readLimited(resp.Body, 16<<20)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		if err = yaml.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("OpenAPI 文档无效: %w", err)
		}
	}
	if doc["openapi"] == nil && doc["swagger"] == nil {
		return nil, errors.New("文档缺少 openapi/swagger 版本")
	}
	if _, ok := doc["paths"].(map[string]any); !ok {
		return nil, errors.New("文档缺少 paths")
	}
	if err = repository.WriteJSON(s.cachePath(source.DocURL), doc); err != nil {
		return nil, err
	}
	return doc, nil
}
func (s *Service) document(ctx context.Context, source Source) (map[string]any, error) {
	raw, err := os.ReadFile(s.cachePath(source.DocURL))
	var doc map[string]any
	if err == nil && json.Unmarshal(raw, &doc) == nil && doc != nil {
		return doc, nil
	}
	return s.fetch(ctx, source)
}
func (s *Service) Request(ctx context.Context, action string, args map[string]any) (any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sources, err := s.list()
	if err != nil {
		return nil, err
	}
	switch action {
	case "sources":
		return sources, nil
	case "save", "refresh":
		raw, _ := json.Marshal(args)
		var input Source
		if err = json.Unmarshal(raw, &input); err != nil {
			return nil, err
		}
		input.DocURL = strings.TrimSpace(input.DocURL)
		if _, err = httpURL(input.DocURL); err != nil {
			return nil, err
		}
		input.AuthType = strings.ToLower(input.AuthType)
		if input.AuthType == "" {
			input.AuthType = "none"
		}
		if input.AuthType != "none" && input.AuthType != "bearer" && input.AuthType != "basic" && input.AuthType != "apikey" {
			return nil, errors.New("不支持的认证方式")
		}
		if input.BaseURL != "" {
			if _, err = httpURL(input.BaseURL); err != nil {
				return nil, err
			}
		}
		_, loadErr := s.fetch(ctx, input)
		input.Enabled = true
		input.Status = "loaded"
		input.ErrorMessage = ""
		if loadErr != nil {
			input.Status = "error"
			input.ErrorMessage = loadErr.Error()
		}
		next := []Source{}
		for _, source := range sources {
			if source.DocURL != input.DocURL {
				next = append(next, source)
			}
		}
		next = append(next, input)
		if err = repository.WriteJSON(s.sourcesPath(), next); err != nil {
			return nil, err
		}
		if loadErr != nil {
			return nil, fmt.Errorf("OpenAPI 源注册失败: %w", loadErr)
		}
		return input, nil
	case "remove":
		docURL := text(args["docUrl"])
		if docURL == "" {
			return nil, errors.New("docUrl 不能为空")
		}
		next := []Source{}
		for _, source := range sources {
			if source.DocURL != docURL {
				next = append(next, source)
			}
		}
		if err = repository.WriteJSON(s.sourcesPath(), next); err != nil {
			return nil, err
		}
		_ = os.Remove(s.cachePath(docURL))
		return map[string]any{"removed": true}, nil
	case "search":
		keywords := strings.Fields(strings.ToLower(text(args["keyword"])))
		if len(keywords) == 0 {
			return nil, errors.New("keyword 不能为空")
		}
		results := []map[string]any{}
		for _, source := range sources {
			if !source.Enabled || source.Status != "loaded" {
				continue
			}
			doc, err := s.document(ctx, source)
			if err != nil {
				return nil, err
			}
			for path, v := range object(doc["paths"]) {
				for method, definition := range object(v) {
					if !isMethod(method) {
						continue
					}
					op := object(definition)
					raw, _ := json.Marshal(op)
					haystack := strings.ToLower(path + " " + method + " " + string(raw))
					match := true
					for _, keyword := range keywords {
						if !strings.Contains(haystack, keyword) {
							match = false
							break
						}
					}
					if match {
						results = append(results, summary(source, path, method, op))
					}
				}
			}
		}
		sort.Slice(results, func(i, j int) bool {
			return text(results[i]["docUrl"])+text(results[i]["endpoint"]) < text(results[j]["docUrl"])+text(results[j]["endpoint"])
		})
		if len(results) > 100 {
			results = results[:100]
		}
		return results, nil
	case "detail", "call":
		var source Source
		found := false
		for _, v := range sources {
			if v.DocURL == text(args["docUrl"]) && v.Enabled && v.Status == "loaded" {
				source = v
				found = true
				break
			}
		}
		if !found {
			return nil, errors.New("接口源不存在或未加载")
		}
		doc, err := s.document(ctx, source)
		if err != nil {
			return nil, err
		}
		path := text(args["path"])
		method := strings.ToLower(text(args["method"]))
		item, err := resolve(doc, object(doc["paths"])[path], 0)
		if err != nil {
			return nil, err
		}
		op, ok := object(item)[method].(map[string]any)
		if !isMethod(method) || !ok {
			return nil, errors.New("接口未在文档中声明")
		}
		details := summary(source, path, method, op)
		consumes := op["consumes"]
		if consumes == nil {
			consumes = doc["consumes"]
		}
		details["consumes"] = consumes
		parameters := append([]any{}, array(object(item)["parameters"])...)
		parameters = append(parameters, array(op["parameters"])...)
		details["parameters"], err = resolve(doc, parameters, 0)
		if err != nil {
			return nil, err
		}
		// Operation parameters override path-level declarations with the
		// same name and location, as required by OpenAPI.
		merged := []any{}
		indices := map[string]int{}
		for _, parameter := range array(details["parameters"]) {
			p := object(parameter)
			key := text(p["in"]) + "\x00" + text(p["name"])
			if at, exists := indices[key]; exists {
				merged[at] = parameter
			} else {
				indices[key] = len(merged)
				merged = append(merged, parameter)
			}
		}
		details["parameters"] = merged
		for _, key := range []string{"requestBody", "responses", "security"} {
			details[key], err = resolve(doc, op[key], 0)
			if err != nil {
				return nil, err
			}
		}
		base, err := baseURL(source, doc, object(item), op)
		if err != nil {
			return nil, err
		}
		details["baseUrl"] = base
		if action == "detail" {
			return details, nil
		}
		return execute(ctx, source, path, method, base, details, args)
	default:
		return nil, errors.New("不支持的 OpenAPI 操作")
	}
}
func isMethod(s string) bool {
	switch s {
	case "get", "post", "put", "patch", "delete", "head", "options", "trace":
		return true
	}
	return false
}
func array(v any) []any { a, _ := v.([]any); return a }
func summary(source Source, path, method string, op map[string]any) map[string]any {
	name := text(op["operationId"])
	if name == "" {
		name = text(op["summary"])
	}
	if name == "" {
		name = strings.ToUpper(method) + " " + path
	}
	return map[string]any{"api_name": name, "category": op["tags"], "endpoint": strings.ToUpper(method) + " " + path, "docUrl": source.DocURL, "method": strings.ToUpper(method), "path": path, "summary": op["summary"], "description": op["description"], "operationId": op["operationId"]}
}
func resolve(doc map[string]any, value any, depth int) (any, error) {
	if depth > 20 {
		return map[string]any{"description": "递归结构，请按文档 schema 填写"}, nil
	}
	switch v := value.(type) {
	case map[string]any:
		if ref := text(v["$ref"]); ref != "" {
			if !strings.HasPrefix(ref, "#/") {
				return nil, errors.New("暂不支持外部 $ref，请使用包含本地 schema 的文档")
			}
			var node any = doc
			for _, part := range strings.Split(ref[2:], "/") {
				part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
				node = object(node)[part]
				if node == nil {
					return nil, fmt.Errorf("无法解析 $ref: %s", ref)
				}
			}
			return resolve(doc, node, depth+1)
		}
		out := map[string]any{}
		for key, item := range v {
			next, err := resolve(doc, item, depth+1)
			if err != nil {
				return nil, err
			}
			out[key] = next
		}
		return out, nil
	case []any:
		out := make([]any, 0, len(v))
		for _, item := range v {
			next, err := resolve(doc, item, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, next)
		}
		return out, nil
	default:
		return value, nil
	}
}
func baseURL(source Source, doc, item, op map[string]any) (string, error) {
	if source.BaseURL != "" {
		return source.BaseURL, nil
	}
	for _, scope := range []map[string]any{op, item, doc} {
		servers := array(scope["servers"])
		if len(servers) == 0 {
			continue
		}
		server := object(servers[0])
		raw := text(server["url"])
		for key, v := range object(server["variables"]) {
			raw = strings.ReplaceAll(raw, "{"+key+"}", text(object(v)["default"]))
		}
		origin, _ := url.Parse(source.DocURL)
		relative, err := url.Parse(raw)
		if err != nil {
			return "", err
		}
		target := origin.ResolveReference(relative)
		if _, err = httpURL(target.String()); err != nil {
			return "", err
		}
		return target.String(), nil
	}
	origin, _ := url.Parse(source.DocURL)
	if host := text(doc["host"]); host != "" {
		origin.Host = host
		if schemes := array(doc["schemes"]); len(schemes) > 0 {
			origin.Scheme = text(schemes[0])
		}
	}
	origin.Path = text(doc["basePath"])
	origin.RawQuery = ""
	origin.Fragment = ""
	if _, err := httpURL(origin.String()); err != nil {
		return "", err
	}
	return origin.String(), nil
}
func execute(ctx context.Context, source Source, path, method, base string, details, args map[string]any) (any, error) {
	contentType := "application/json"
	if args["body"] != nil {
		content := object(object(details["requestBody"])["content"])
		if len(content) > 0 {
			contentType = ""
			for name := range content {
				if name == "application/json" || strings.HasSuffix(name, "+json") {
					contentType = name
					break
				}
			}
			if contentType == "" {
				return nil, errors.New("此接口不接受 JSON 请求体，暂不支持表单、文件或二进制上传")
			}
		}
		if consumes := array(details["consumes"]); len(consumes) > 0 {
			contentType = ""
			for _, item := range consumes {
				name := text(item)
				if name == "application/json" || strings.HasSuffix(name, "+json") {
					contentType = name
					break
				}
			}
			if contentType == "" {
				return nil, errors.New("此接口不接受 JSON 请求体")
			}
		}
	}
	pathParams := object(args["pathParams"])
	queryParams := object(args["query"])
	headers := object(args["headers"])
	for _, v := range array(details["parameters"]) {
		p := object(v)
		if text(p["in"]) == "formData" {
			return nil, errors.New("暂不支持 formData，请使用 JSON 接口")
		}
		name := text(p["name"])
		required, _ := p["required"].(bool)
		if !required {
			continue
		}
		var value any
		switch text(p["in"]) {
		case "path":
			value = pathParams[name]
		case "query":
			value = queryParams[name]
		case "header":
			for key, val := range headers {
				if strings.EqualFold(key, name) {
					value = val
				}
			}
			probe, _ := http.NewRequest(http.MethodGet, "http://localhost", nil)
			authorize(probe, source)
			if configured := probe.Header.Get(name); configured != "" {
				value = configured
			}
			if value == nil {
				for key, val := range source.Headers {
					if strings.EqualFold(key, name) {
						value = val
					}
				}
			}
		case "body":
			value = args["body"]
		}
		if value == nil {
			return nil, fmt.Errorf("缺少必填参数: %s", name)
		}
	}
	if required, _ := object(details["requestBody"])["required"].(bool); required && args["body"] == nil {
		return nil, errors.New("缺少必填请求体")
	}
	for key, v := range pathParams {
		path = strings.ReplaceAll(path, "{"+key+"}", url.PathEscape(fmt.Sprint(v)))
	}
	if strings.ContainsAny(path, "{}") || !strings.HasPrefix(path, "/") || strings.Contains(path, "?") || strings.Contains(path, "#") {
		return nil, errors.New("接口路径无效或缺少路径参数")
	}
	target, err := httpURL(strings.TrimRight(base, "/") + path)
	if err != nil {
		return nil, err
	}
	q := target.Query()
	for key, v := range queryParams {
		if values, ok := v.([]any); ok {
			for _, value := range values {
				q.Add(key, fmt.Sprint(value))
			}
		} else {
			q.Set(key, fmt.Sprint(v))
		}
	}
	target.RawQuery = q.Encode()
	var body io.Reader
	if v, ok := args["body"]; ok && v != nil {
		raw, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), target.String(), body)
	if err != nil {
		return nil, err
	}
	for key, v := range headers {
		if strings.EqualFold(key, "Host") || strings.EqualFold(key, "Authorization") {
			return nil, errors.New("认证请在接口源中配置")
		}
		req.Header.Set(key, fmt.Sprint(v))
	}
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	authorize(req, source)
	resp, err := client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := readLimited(resp.Body, 2<<20)
	if err != nil {
		return nil, err
	}
	var result any = string(raw)
	_ = json.Unmarshal(raw, &result)
	return map[string]any{"status": resp.StatusCode, "ok": resp.StatusCode >= 200 && resp.StatusCode < 300, "contentType": resp.Header.Get("Content-Type"), "body": result}, nil
}

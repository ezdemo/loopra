package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/net/html/charset"
	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
)

const (
	exaSearchEndpoint = "https://mcp.exa.ai/mcp"
	exaCodeEndpoint   = "https://mcp.exa.ai/mcp?tools=get_code_context_exa"
	exaTimeout        = 30 * time.Second
	exaRetries        = 3
	webDefaultTimeout = 30 * time.Second
	webMaxTimeout     = 120 * time.Second
	webMaxBody        = 5 << 20
	webUserAgent      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)

type exaResult struct {
	text    string
	isError bool
}

// callExa 调用 Exa 的公开 MCP。测试会替换它。
var callExa = callExaMCP

const webDescription = `联网检索与读取。用 action 选择行为：
- search：实时网页搜索。填写 query，numResults 默认 8。
- code：检索库、SDK 和 API 的代码与文档。填写 query，numResults 为 1-20，默认 8。
- fetch：读取 url 指向的页面。format 为 markdown、text 或 html，默认 markdown；timeoutMs 最大 120000。`

// WebTools 是内嵌的联网工具：搜索、代码检索和页面读取共用一个入口。
func WebTools() []Tool {
	return []Tool{
		{webTool(), Metadata{Name: "web", Description: webDescription, ReadOnly: true, AutoApprove: true}},
	}
}

type webInput struct {
	Action     string `json:"action" jsonschema:"search 网页搜索，code 代码与文档检索，fetch 读取页面"`
	Query      string `json:"query,omitempty" jsonschema:"search 和 code 的查询词"`
	URL        string `json:"url,omitempty" jsonschema:"fetch 的完整 URL，必须以 http:// 或 https:// 开头"`
	NumResults int    `json:"numResults,omitempty" jsonschema:"search 和 code 的结果数量，默认 8，code 最大 20"`
	Format     string `json:"format,omitempty" jsonschema:"fetch 的返回格式：markdown、text 或 html，默认 markdown"`
	TimeoutMs  int    `json:"timeoutMs,omitempty" jsonschema:"fetch 的超时毫秒数，最大 120000"`
}

func webTool() tool.Tool {
	t, _ := functiontool.New[webInput, map[string]any](functiontool.Config{Name: "web", Description: webDescription},
		func(ctx agentpkg.Context, in webInput) (map[string]any, error) {
			text, err := runWeb(ctx, in)
			if err != nil {
				return nil, err
			}
			return map[string]any{"result": text}, nil
		})
	return t
}

func runWeb(ctx context.Context, in webInput) (string, error) {
	switch strings.ToLower(strings.TrimSpace(in.Action)) {
	case "search", "websearch":
		return runWebSearch(ctx, in.Query, in.NumResults)
	case "code", "codesearch":
		return runCodeSearch(ctx, in.Query, in.NumResults)
	case "fetch", "webfetch":
		return retryRemote(ctx, exaRetries, func(ctx context.Context) (string, error) {
			return fetchWeb(ctx, in.URL, in.Format, time.Duration(in.TimeoutMs)*time.Millisecond)
		})
	default:
		return "", fmt.Errorf("action 必须是 search、code 或 fetch")
	}
}

func runWebSearch(ctx context.Context, query string, count int) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("query 不能为空")
	}
	if count <= 0 {
		count = 8
	}
	result, err := retryExa(ctx, func(ctx context.Context) (exaResult, error) {
		return callExa(ctx, exaSearchEndpoint, "web_search_exa", map[string]any{"query": query, "numResults": count})
	})
	if err != nil {
		if isTimeout(err) {
			return "", fmt.Errorf("Search request timed out")
		}
		return "", err
	}
	if result.isError {
		msg := strings.TrimSpace(result.text)
		if msg == "" {
			msg = "Search service error"
		}
		return "", errors.New(msg)
	}
	if strings.TrimSpace(result.text) == "" {
		return "No search results found. Please try a different query.", nil
	}
	return result.text, nil
}

func runCodeSearch(ctx context.Context, query string, count int) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("query 不能为空")
	}
	if count <= 0 {
		count = 8
	}
	if count > 20 {
		count = 20
	}
	result, err := retryExa(ctx, func(ctx context.Context) (exaResult, error) {
		return callExa(ctx, exaCodeEndpoint, "get_code_context_exa", map[string]any{"query": query, "numResults": count})
	})
	if err != nil {
		if isTimeout(err) {
			return "", fmt.Errorf("代码搜索请求超时")
		}
		return "", err
	}
	if result.isError {
		msg := strings.TrimSpace(result.text)
		if msg == "" {
			msg = "Unknown error"
		}
		return "", fmt.Errorf("代码搜索出错: %s", msg)
	}
	if strings.TrimSpace(result.text) == "" {
		return "未找到相关的代码片段或文档。请尝试更换查询词，明确具体的库或编程概念，并检查框架名称拼写是否正确。", nil
	}
	return result.text, nil
}

func retryExa(ctx context.Context, fn func(context.Context) (exaResult, error)) (exaResult, error) {
	var last error
	for i := 0; i < exaRetries; i++ {
		if ctx.Err() != nil {
			return exaResult{}, ctx.Err()
		}
		result, err := fn(ctx)
		if err == nil {
			return result, nil
		}
		if errors.Is(err, context.Canceled) {
			return exaResult{}, err
		}
		last = err
	}
	return exaResult{}, last
}

func retryRemote(ctx context.Context, times int, fn func(context.Context) (string, error)) (string, error) {
	if times < 1 {
		times = 1
	}
	var err error
	for i := 0; i < times; i++ {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		var text string
		text, err = fn(ctx)
		if err == nil {
			return text, nil
		}
		if errors.Is(err, context.Canceled) {
			return "", err
		}
	}
	return "", err
}

func callExaMCP(ctx context.Context, endpoint, name string, args map[string]any) (exaResult, error) {
	ctx, cancel := context.WithTimeout(ctx, exaTimeout)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "loopra", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: endpoint}, nil)
	if err != nil {
		return exaResult{}, err
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return exaResult{}, err
	}
	return exaResult{text: mcpText(result), isError: result.IsError}, nil
}

func mcpText(result *mcp.CallToolResult) string {
	if result == nil {
		return ""
	}
	var text strings.Builder
	for _, item := range result.Content {
		if part, ok := item.(*mcp.TextContent); ok {
			if text.Len() > 0 && part.Text != "" {
				text.WriteByte('\n')
			}
			text.WriteString(part.Text)
		}
	}
	return text.String()
}

func fetchWeb(ctx context.Context, rawURL, format string, timeout time.Duration) (string, error) {
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return "", fmt.Errorf("URL must start with http:// or https://")
	}
	if timeout <= 0 || timeout > webMaxTimeout {
		timeout = webDefaultTimeout
	}
	format = strings.ToLower(strings.TrimSpace(format))
	if format == "" {
		format = "markdown"
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, contentType, err := httpGet(ctx, rawURL, acceptHeader(format), webUserAgent)
	if err != nil {
		return "", err
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if strings.HasPrefix(mimeType, "image/") && !strings.Contains(mimeType, "svg") && !strings.Contains(mimeType, "vnd.fastbidsheet") {
		return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(body), nil
	}
	decoded, err := decodeBody(body, contentType)
	if err != nil {
		return "", err
	}
	raw := string(decoded)
	if mimeType == "text/html" && format == "markdown" {
		return htmlToMarkdown(raw), nil
	}
	if mimeType == "text/html" && format == "text" {
		return htmlToText(raw), nil
	}
	return raw, nil
}

func httpGet(ctx context.Context, rawURL, accept, userAgent string) ([]byte, string, error) {
	body, header, status, err := doGet(ctx, rawURL, accept, userAgent)
	if err != nil {
		return nil, "", err
	}
	if status == http.StatusForbidden && header.Get("Cf-Mitigated") == "challenge" {
		body, header, status, err = doGet(ctx, rawURL, accept, "opencode")
		if err != nil {
			return nil, "", err
		}
	}
	if status >= 400 {
		return nil, "", fmt.Errorf("Request failed with status code: %d", status)
	}
	return body, header.Get("Content-Type"), nil
}

func doGet(ctx context.Context, rawURL, accept, userAgent string) ([]byte, http.Header, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, nil, 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()
	if resp.ContentLength > webMaxBody {
		return nil, nil, 0, fmt.Errorf("Response too large (exceeds 5MB limit)")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, webMaxBody+1))
	if err != nil {
		return nil, nil, 0, err
	}
	if len(body) > webMaxBody {
		return nil, nil, 0, fmt.Errorf("Response too large (exceeds 5MB limit)")
	}
	return body, resp.Header.Clone(), resp.StatusCode, nil
}

func decodeBody(body []byte, contentType string) ([]byte, error) {
	reader, err := charset.NewReader(bytes.NewReader(body), contentType)
	if err != nil {
		return body, nil
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		return body, nil
	}
	return decoded, nil
}

func acceptHeader(format string) string {
	switch format {
	case "markdown":
		return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
	case "text":
		return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
	case "html":
		return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
	default:
		return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	}
}

func isTimeout(err error) bool {
	return err != nil && (errors.Is(err, context.DeadlineExceeded) || strings.Contains(strings.ToLower(err.Error()), "timeout"))
}

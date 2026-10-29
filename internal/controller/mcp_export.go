package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type mcpEndpoint struct {
	mu        sync.Mutex
	signature string
	handler   http.Handler
}

func containsString(items []string, name string) bool {
	for _, item := range items {
		if item == name {
			return true
		}
	}
	return false
}

func (s *Controller) resetMcpExport() {
	e := s.state.export
	e.mu.Lock()
	e.signature = ""
	e.handler = nil
	e.mu.Unlock()
}

func (s *Controller) exportHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := s.mcpExportLoad()
		if cfg.Enabled == nil || !*cfg.Enabled || !(r.URL.Path == cfg.Endpoint || strings.HasPrefix(r.URL.Path, cfg.Endpoint+"/")) {
			next.ServeHTTP(w, r)
			return
		}
		if !s.key.Match(r.Header.Get("X-Loopra-Key")) {
			writeFailReason(w, http.StatusUnauthorized, "访问密钥缺失或错误，请输入启动日志中的 rk 密钥", "access_key_required")
			return
		}
		view, err := s.projectRuntime("")
		if err != nil {
			writeFail(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		handler, err := view.mcpExportHandler(cfg)
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		handler.ServeHTTP(w, r)
	})
}

func (s *Controller) mcpExportHandler(cfg McpExportConfig) (http.Handler, error) {
	e := s.state.export
	e.mu.Lock()
	defer e.mu.Unlock()
	var toolsView any
	if s.registry != nil {
		toolsView = s.registry.List()
	}
	key, _ := json.Marshal([]any{cfg, s.agent.App(), toolsView})
	if e.handler != nil && e.signature == string(key) {
		return e.handler, nil
	}
	server := mcp.NewServer(&mcp.Implementation{Name: cfg.Name, Version: cfg.Version}, nil)
	allowed := map[string]bool{}
	for _, name := range cfg.AllowedTools {
		allowed[tools.ResolveName(name)] = true
	}
	if s.registry != nil {
		for _, entry := range s.registry.Entries() {
			name := entry.Meta.Name
			if s.registry.Disabled(name) || (cfg.AllowedTools != nil && !allowed[name]) {
				continue
			}
			declarer, ok := entry.Tool.(interface {
				Declaration() *genai.FunctionDeclaration
			})
			if !ok {
				continue
			}
			decl := declarer.Declaration()
			schema := decl.ParametersJsonSchema
			if schema == nil {
				schema = map[string]any{"type": "object"}
			}
			server.AddTool(&mcp.Tool{Name: name, Description: entry.Meta.Description, InputSchema: schema}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				var args map[string]any
				if len(request.Params.Arguments) > 0 {
					if err := json.Unmarshal(request.Params.Arguments, &args); err != nil {
						return nil, err
					}
				}
				result, err := s.callExportTool(ctx, name, args)
				if err != nil {
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}, nil
				}
				raw, err := json.Marshal(result)
				if err != nil {
					return nil, err
				}
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}}, nil
			})
		}
	}
	getServer := func(*http.Request) *mcp.Server { return server }
	if cfg.Channel == "sse" {
		e.handler = mcp.NewSSEHandler(getServer, nil)
	} else {
		e.handler = mcp.NewStreamableHTTPHandler(getServer, &mcp.StreamableHTTPOptions{Stateless: cfg.Channel == "streamable_stateless", SessionTimeout: 30 * time.Minute})
	}
	e.signature = string(key)
	return e.handler, nil
}

func (s *Controller) callExportTool(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	script := echo.New("mcp-dispatch", echo.Script{ToolCalls: []*genai.FunctionCall{{ID: newUUIDv4(), Name: name, Args: args}}}, echo.Script{Text: ""})
	// 导出工具的调用属于内部派发，不能把临时会话写进用户的会话目录：
	// 使用独立的临时存储，调用结束即整体删除（Java 直接 delegate，
	// 根本不会创建会话）。
	store, err := os.MkdirTemp("", "looprax-mcp-export-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(store)
	a, err := agentpkg.New(store, s.agent.App(), s.cfg, agentpkg.Options{Model: script, Toolsets: []tool.Toolset{s.registry}})
	if err != nil {
		return nil, err
	}
	id := "mcp-" + newUUIDv4()
	sess, err := a.Session(ctx, id)
	if err != nil {
		return nil, err
	}
	for event, err := range a.Run(ctx, sess, userContent("Execute "+name, nil)) {
		if err != nil {
			return nil, err
		}
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if part.FunctionCall != nil && part.FunctionCall.Name == toolconfirmation.FunctionCallName {
				return nil, fmt.Errorf("工具需要交互审批，请通过聊天会话执行")
			}
			if part.FunctionResponse != nil && part.FunctionResponse.Name == name {
				return part.FunctionResponse.Response, nil
			}
		}
	}
	return nil, fmt.Errorf("工具未返回结果: %s", name)
}

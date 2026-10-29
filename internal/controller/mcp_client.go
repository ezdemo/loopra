package controller

import (
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"

	"github.com/ezdemo/looprax/internal/service/toolsearch"
)

type headerTransport struct {
	Base    http.RoundTripper
	Headers map[string]string
}

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	for key, value := range t.Headers {
		clone.Header.Set(key, value)
	}
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(clone)
}

func mcpClientConfig(server McpServer) mcptoolset.Config {
	client := &http.Client{Transport: headerTransport{Headers: server.Headers}}
	switch server.Type {
	case "stdio":
		cmd := exec.Command(server.Command, server.Args...)
		hideProcess(cmd)
		if len(server.Env) > 0 {
			cmd.Env = append(os.Environ(), envPairs(server.Env)...)
		}
		return mcptoolset.Config{Transport: &mcp.CommandTransport{Command: cmd}}
	case "sse":
		return mcptoolset.Config{Transport: &mcp.SSEClientTransport{Endpoint: server.URL, HTTPClient: client}}
	default:
		return mcptoolset.Config{Transport: &mcp.StreamableClientTransport{Endpoint: server.URL, HTTPClient: client, MaxRetries: -1}}
	}
}

func (s *Controller) configuredMcpServers() []McpServer {
	servers := map[string]McpServer{}
	for _, server := range s.mcpView() {
		servers[server.Name] = server
	}
	for _, server := range projectMcpServers(filepath.Join(s.workspaceRoot(), ".loopra", "mcp-servers.json")) {
		servers[server.Name] = server
	}
	out := []McpServer{}
	preferences := s.engineMcpPreferences()
	for _, server := range servers {
		if enabled, ok := preferences.Agents["native"][server.Name]; ok {
			server.Enabled = enabled
		}
		out = append(out, server)
	}
	return out
}

func (s *Controller) turnMcpSets(session string) ([]tool.Toolset, []io.Closer) {
	sources := []toolsearch.Source{}
	for _, server := range s.configuredMcpServers() {
		if !server.Enabled {
			continue
		}
		cfg := mcpClientConfig(server)
		filter := func(ctx agentctx.ReadonlyContext, t tool.Tool) bool {
			return s.sessionMetaRead(session)["planMode"] != true && !containsString(server.DisallowedTools, t.Name())
		}
		cfg.RequireConfirmationProvider = func(name string, args any) bool {
			input, _ := args.(map[string]any)
			return s.approvalPolicy != nil && s.approvalPolicy.Require(session, toolsearch.QualifiedName(server.Name, name), input)
		}
		set, err := mcptoolset.New(cfg)
		if err != nil {
			continue
		}
		timeout := 15 * time.Second
		if configured, err := parseMcpTimeout(server.Timeout); err == nil {
			timeout = configured
		}
		sources = append(sources, toolsearch.Source{
			Name: server.Name, Toolset: set, Timeout: timeout, Filter: filter,
		})
	}
	deferred, err := toolsearch.New(sources)
	if err != nil {
		for _, source := range sources {
			if closer, ok := source.Toolset.(io.Closer); ok {
				_ = closer.Close()
			}
		}
		return nil, nil
	}
	return []tool.Toolset{deferred}, []io.Closer{deferred}
}

func (s *Controller) closeTurnTools() {
	for _, closer := range s.turnClosers {
		_ = closer.Close()
	}
}

package acpserver

import (
	"net/http"
	"os"
	"os/exec"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	mcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"

	"github.com/ezdemo/looprax/internal/infrastructure/hideconsole"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/toolsearch"
)

func (s *liveSession) mcpToolset() tool.Toolset {
	if s.mcp != nil || len(s.servers) == 0 {
		return s.mcp
	}
	var sources []toolsearch.Source
	for _, server := range s.servers {
		name, cfg, ok := mcpToolConfig(server)
		if !ok {
			continue
		}
		set, err := mcptoolset.New(cfg)
		if err != nil {
			logging.Warnf("acp", "跳过 MCP %s：%v", name, err)
			continue
		}
		sources = append(sources, toolsearch.Source{Name: name, Toolset: set, Timeout: 15 * time.Second})
	}
	if len(sources) == 0 {
		return nil
	}
	deferred, err := toolsearch.New(sources)
	if err != nil {
		logging.Warnf("acp", "MCP 工具未接入：%v", err)
		return nil
	}
	s.mcp = deferred
	return deferred
}

func mcpToolConfig(server acpsdk.McpServer) (string, mcptoolset.Config, bool) {
	switch {
	case server.Http != nil && server.Http.Url != "":
		return server.Http.Name, mcptoolset.Config{Transport: &mcp.StreamableClientTransport{
			Endpoint: server.Http.Url, HTTPClient: headerClient(server.Http.Headers), MaxRetries: -1,
		}}, true
	case server.Sse != nil && server.Sse.Url != "":
		return server.Sse.Name, mcptoolset.Config{Transport: &mcp.SSEClientTransport{
			Endpoint: server.Sse.Url, HTTPClient: headerClient(server.Sse.Headers),
		}}, true
	case server.Stdio != nil && server.Stdio.Command != "":
		cmd := exec.Command(server.Stdio.Command, server.Stdio.Args...)
		hideconsole.Apply(cmd)
		if len(server.Stdio.Env) > 0 {
			cmd.Env = append(os.Environ(), envPairs(server.Stdio.Env)...)
		}
		return server.Stdio.Name, mcptoolset.Config{Transport: &mcp.CommandTransport{Command: cmd}}, true
	default:
		return "", mcptoolset.Config{}, false
	}
}

func headerClient(headers []acpsdk.HttpHeader) *http.Client {
	if len(headers) == 0 {
		return http.DefaultClient
	}
	values := map[string]string{}
	for _, header := range headers {
		if header.Name != "" {
			values[header.Name] = header.Value
		}
	}
	return &http.Client{Transport: headerTransport{Headers: values}}
}

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

func envPairs(values []acpsdk.EnvVariable) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, value.Name+"="+value.Value)
	}
	return out
}

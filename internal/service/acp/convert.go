package acp

import (
	"encoding/json"
	"fmt"

	acpsdk "github.com/coder/acp-go-sdk"
)

func localCapabilities(caps acpsdk.AgentCapabilities) AgentCapabilities {
	session := map[string]any{}
	if caps.SessionCapabilities.Resume != nil {
		session["resume"] = map[string]any{}
	}
	if caps.SessionCapabilities.Fork != nil {
		session["fork"] = map[string]any{}
	}
	if caps.SessionCapabilities.Close != nil {
		session["close"] = map[string]any{}
	}
	if caps.SessionCapabilities.List != nil {
		session["list"] = map[string]any{}
	}
	if caps.SessionCapabilities.Meta != nil {
		if _, ok := caps.SessionCapabilities.Meta["subagents"]; ok {
			session["subagents"] = caps.SessionCapabilities.Meta["subagents"]
		}
	}
	if caps.Meta != nil {
		if _, ok := caps.Meta["subagents"]; ok {
			session["subagents"] = caps.Meta["subagents"]
		}
	}
	return AgentCapabilities{
		LoadSession: caps.LoadSession,
		PromptCapabilities: map[string]any{
			"image":           caps.PromptCapabilities.Image,
			"audio":           caps.PromptCapabilities.Audio,
			"embeddedContext": caps.PromptCapabilities.EmbeddedContext,
		},
		MCPCapabilities: map[string]any{
			"http": caps.McpCapabilities.Http,
			"sse":  caps.McpCapabilities.Sse,
			"acp":  caps.McpCapabilities.Acp,
		},
		SessionCapabilities: session,
		Meta:                caps.Meta,
	}
}

func localUpdate(update acpsdk.SessionUpdate) (SessionUpdate, bool) {
	raw, err := json.Marshal(update)
	if err != nil || len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		return SessionUpdate{}, false
	}
	var out SessionUpdate
	if err := json.Unmarshal(raw, &out); err != nil || out.SessionUpdate == "" {
		return SessionUpdate{}, false
	}
	return out, true
}

func forkConfigOptions(options []acpsdk.UnstableSessionConfigOption) []ConfigOption {
	if len(options) == 0 {
		return nil
	}
	raw, err := json.Marshal(options)
	if err != nil {
		return nil
	}
	var stable []acpsdk.SessionConfigOption
	if json.Unmarshal(raw, &stable) != nil {
		return nil
	}
	return configFromSDK(stable)
}

func setupFromNew(raw acpsdk.NewSessionResponse) SessionSetupResult {
	return SessionSetupResult{
		SessionID:     string(raw.SessionId),
		ConfigOptions: configFromSDK(raw.ConfigOptions),
		Modes:         modesFromSDK(raw.Modes),
	}
}

func modesFromSDK(modes *acpsdk.SessionModeState) *SessionModes {
	if modes == nil {
		return nil
	}
	out := &SessionModes{CurrentModeID: string(modes.CurrentModeId)}
	for _, mode := range modes.AvailableModes {
		item := SessionMode{ID: string(mode.Id), Name: mode.Name}
		if mode.Description != nil {
			item.Description = *mode.Description
		}
		out.AvailableModes = append(out.AvailableModes, item)
	}
	return out
}

func configFromSDK(options []acpsdk.SessionConfigOption) []ConfigOption {
	if len(options) == 0 {
		return nil
	}
	raw, err := json.Marshal(options)
	if err != nil {
		return nil
	}
	var out []ConfigOption
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func sdkBlocks(blocks []ContentBlock) []acpsdk.ContentBlock {
	out := make([]acpsdk.ContentBlock, 0, len(blocks))
	for _, block := range blocks {
		switch block.Type {
		case "image":
			if block.Data != "" {
				mime := block.MIMEType
				if mime == "" {
					mime = "image/png"
				}
				out = append(out, acpsdk.ImageBlock(block.Data, mime))
				continue
			}
			if block.URI != "" {
				out = append(out, acpsdk.TextBlock(block.URI))
				continue
			}
		case "audio":
			if block.Data != "" {
				out = append(out, acpsdk.AudioBlock(block.Data, block.MIMEType))
				continue
			}
		case "resource_link":
			out = append(out, acpsdk.ResourceLinkBlock(block.Name, block.URI))
			continue
		}
		out = append(out, acpsdk.TextBlock(block.Text))
	}
	if out == nil {
		out = []acpsdk.ContentBlock{}
	}
	return out
}

func sdkMCP(servers []any) ([]acpsdk.McpServer, error) {
	out := make([]acpsdk.McpServer, 0, len(servers))
	for _, raw := range servers {
		server, ok := raw.(map[string]any)
		if !ok {
			encoded, err := json.Marshal(raw)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(encoded, &server); err != nil {
				return nil, fmt.Errorf("MCP 定义无法交给 ACP: %w", err)
			}
		}
		kind, _ := server["type"].(string)
		name, _ := server["name"].(string)
		switch kind {
		case "http":
			out = append(out, acpsdk.McpServer{Http: &acpsdk.McpServerHttpInline{
				Name: name, Type: "http", Url: text(server["url"]), Headers: httpHeaders(server["headers"]),
			}})
		case "sse":
			out = append(out, acpsdk.McpServer{Sse: &acpsdk.McpServerSseInline{
				Name: name, Type: "sse", Url: text(server["url"]), Headers: httpHeaders(server["headers"]),
			}})
		default:
			args := stringList(server["args"])
			env := envVars(server["env"])
			out = append(out, acpsdk.McpServer{Stdio: &acpsdk.McpServerStdio{
				Name: name, Command: text(server["command"]), Args: args, Env: env,
			}})
		}
	}
	return out, nil
}

func unstableMCP(servers []acpsdk.McpServer) []acpsdk.UnstableMcpServer {
	if len(servers) == 0 {
		return nil
	}
	raw, err := json.Marshal(servers)
	if err != nil {
		return nil
	}
	var out []acpsdk.UnstableMcpServer
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

func text(value any) string {
	s, _ := value.(string)
	return s
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func httpHeaders(value any) []acpsdk.HttpHeader {
	return namedValues(value, func(name, val string) acpsdk.HttpHeader {
		return acpsdk.HttpHeader{Name: name, Value: val}
	})
}

func envVars(value any) []acpsdk.EnvVariable {
	return namedValues(value, func(name, val string) acpsdk.EnvVariable {
		return acpsdk.EnvVariable{Name: name, Value: val}
	})
}

func namedValues[T any](value any, build func(name, val string) T) []T {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return []T{}
	}
	out := make([]T, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, build(text(entry["name"]), text(entry["value"])))
	}
	return out
}

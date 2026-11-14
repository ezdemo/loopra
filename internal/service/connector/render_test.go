package connector

import (
	"strings"
	"testing"
)

func TestRenderQueryEscapesURLValues(t *testing.T) {
	conn := Connector{
		ID: "amap",
		Transport: Transport{
			Type: "streamable",
			URL:  "https://mcp.amap.com/mcp?key={{key}}",
		},
	}
	spec, err := Render(conn, map[string]string{"key": "a b&c=1"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.URL != "https://mcp.amap.com/mcp?key=a+b%26c%3D1" {
		t.Fatalf("url = %q", spec.URL)
	}
	if spec.Name != "amap" {
		t.Fatalf("name = %q", spec.Name)
	}
}

func TestRenderHeadersAndEnv(t *testing.T) {
	conn := Connector{
		ID: "x",
		Transport: Transport{
			Type:    "stdio",
			Command: "npx",
			Args:    []string{"-y", "pkg"},
			Env:     map[string]string{"APP_SECRET": "{{secret}}"},
			Headers: map[string]string{"Authorization": "Bearer {{token}}"},
		},
	}
	spec, err := Render(conn, map[string]string{"secret": "s 1", "token": "t&2"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Env["APP_SECRET"] != "s 1" || spec.Headers["Authorization"] != "Bearer t&2" {
		t.Fatalf("spec = %+v", spec)
	}
}

func TestRenderMissingField(t *testing.T) {
	conn := Connector{
		ID:        "x",
		Transport: Transport{Type: "streamable", URL: "https://x/mcp?key={{key}}"},
	}
	if _, err := Render(conn, map[string]string{}); err == nil || !strings.Contains(err.Error(), `缺少必填字段 "key"`) {
		t.Fatalf("want missing field error, got %v", err)
	}
}

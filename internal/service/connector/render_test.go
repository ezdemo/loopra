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
		Auth: Auth{Type: "token", Fields: []Field{{Key: "key", Label: "Key"}}},
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
		Auth: Auth{Type: "credentials", Fields: []Field{{Key: "secret", Label: "Secret"}, {Key: "token", Label: "Token"}}},
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
		Auth:      Auth{Type: "token", Fields: []Field{{Key: "key", Label: "Key"}}},
	}
	if _, err := Render(conn, map[string]string{}); err == nil || !strings.Contains(err.Error(), `缺少必填字段 "key"`) {
		t.Fatalf("want missing field error, got %v", err)
	}
}

func TestRenderAppliesDefaultsAndRejectsUnknown(t *testing.T) {
	conn := Connector{
		ID: "x",
		Transport: Transport{
			Type:    "streamable",
			URL:     "https://x/mcp",
			Headers: map[string]string{"Authorization": "Bearer {{token}}", "X-Region": "{{region}}"},
		},
		Auth: Auth{Type: "token", Fields: []Field{
			{Key: "token", Label: "Token", Secret: true},
			{Key: "region", Label: "Region", Optional: true, Default: "cn"},
		}},
	}
	spec, err := Render(conn, map[string]string{"token": "t"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Headers["X-Region"] != "cn" {
		t.Fatalf("default not applied: %v", spec.Headers)
	}
	if _, err := Render(conn, map[string]string{"token": "t", "ghost": "x"}); err == nil || !strings.Contains(err.Error(), "未知字段") {
		t.Fatalf("want unknown field error, got %v", err)
	}
}

func TestRenderOmitsUnresolvedOptionalValues(t *testing.T) {
	conn := Connector{
		ID: "x",
		Transport: Transport{
			Type:    "stdio",
			Command: "npx",
			Args:    []string{"-y", "pkg", "{{opt}}"},
			Env:     map[string]string{"REQ": "{{token}}", "OPT": "{{opt}}"},
			Headers: map[string]string{"X-Opt": "{{opt}}"},
		},
		Auth: Auth{Type: "token", Fields: []Field{
			{Key: "token", Label: "Token", Secret: true},
			{Key: "opt", Label: "Opt", Optional: true},
		}},
	}
	spec, err := Render(conn, map[string]string{"token": "t"})
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Args) != 2 {
		t.Fatalf("optional arg not omitted: %v", spec.Args)
	}
	if _, ok := spec.Env["OPT"]; ok {
		t.Fatalf("optional env not omitted: %v", spec.Env)
	}
	if _, ok := spec.Headers["X-Opt"]; ok {
		t.Fatalf("optional header not omitted: %v", spec.Headers)
	}
	for _, s := range append(spec.Args, spec.Env["REQ"], spec.Headers["Authorization"]) {
		if strings.Contains(s, "{{") {
			t.Fatalf("unresolved placeholder in %q", s)
		}
	}
	spec, err = Render(conn, map[string]string{"token": "t", "opt": "v"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Env["OPT"] != "v" || spec.Args[2] != "v" {
		t.Fatalf("optional values not rendered: %+v", spec)
	}
}

func TestRenderRejectsCRLFAndBadURLField(t *testing.T) {
	conn := Connector{
		ID: "x",
		Transport: Transport{
			Type:    "streamable",
			URL:     "https://x/mcp",
			Headers: map[string]string{"Authorization": "Bearer {{token}}"},
		},
		Auth: Auth{Type: "token", Fields: []Field{{Key: "token", Label: "Token", Secret: true}}},
	}
	if _, err := Render(conn, map[string]string{"token": "a\r\nb"}); err == nil {
		t.Fatal("want CRLF rejection")
	}
	urlConn := Connector{
		ID:        "u",
		Transport: Transport{Type: "streamable", URL: "https://x/mcp?next={{dest}}"},
		Auth:      Auth{Type: "token", Fields: []Field{{Key: "dest", Label: "Dest", Type: "url"}}},
	}
	if _, err := Render(urlConn, map[string]string{"dest": "ftp://bad"}); err == nil {
		t.Fatal("want url type rejection")
	}
	if _, err := Render(urlConn, map[string]string{"dest": "https://ok/path"}); err != nil {
		t.Fatal(err)
	}
}

func TestRenderWholeURLTemplate(t *testing.T) {
	conn := Connector{
		ID:        "u",
		Transport: Transport{Type: "streamable", URL: "{{endpoint}}"},
		Auth:      Auth{Type: "credentials", Fields: []Field{{Key: "endpoint", Label: "Endpoint", Type: "url"}}},
	}
	spec, err := Render(conn, map[string]string{"endpoint": "https://mcp.example.com/v1?key=a b"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.URL != "https://mcp.example.com/v1?key=a b" {
		t.Fatalf("url = %q", spec.URL)
	}
	for _, bad := range []string{"ftp://x", "https://u:p@x/mcp", "https://x/mcp\nHost: y"} {
		if _, err := Render(conn, map[string]string{"endpoint": bad}); err == nil {
			t.Fatalf("want rejection for %q", bad)
		}
	}
}
